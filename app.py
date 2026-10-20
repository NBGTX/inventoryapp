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
import time
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
        self._window = None
        self._busy = 0           # long write operations in flight (a division switch must wait)
        self._busy_lock = threading.Lock()
        self._spm_scans = {}
        self._spm_scans_lock = threading.Lock()
        self._spm_inheritance_plans = {}
        self._spm_inheritance_lock = threading.Lock()
        self._spm_copy_plans = {}
        self._spm_copy_lock = threading.Lock()
        self._spm_link_plans = {}
        self._spm_link_lock = threading.Lock()

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

    def trial_mode(self) -> dict:
        """Tell the UI whether this launch is the isolated trial copy."""
        return {"ok": True, "enabled": os.environ.get("NBG_HUB_TRIAL_MODE") == "1"}

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
            ot_lists = self._clean_ot_lists(prefs.get("ot_lists"))
            ot_stale_months = self._clean_ot_stale_months(prefs.get("ot_stale_months"))
            try:
                smtp = sc.clean_smtp_settings(prefs.get("smtp"))
            except ValueError:
                smtp = sc.clean_smtp_settings(None)
            import notify
            division_subs = notify.division_subscribers_doc(prefs.get("issue_subscribers"))
            return {"ok": True, "timezone": tz, "default": dflt, "effective": tz or dflt, "zones": sc.zones(),
                    "project_hub_url": ph, "project_hub_default": ph_def, "project_hub_effective": ph or ph_def,
                    "device_os": dos, "device_os_options": [{"id": k, "label": v} for k, v in sc.DEVICE_OS],
                    "hot_spare_depts": depts, "hot_spare_default": sc.HOT_SPARE_DEFAULT,
                    "hot_spare_effective": (depts or sc.HOT_SPARE_DEFAULT) + ["Other"],
                    "ot_lists": ot_lists,
                    "ot_stale_months": ot_stale_months,
                    "hot_spare_minimum": max(0, min(500, int(prefs.get("hot_spare_minimum", 0) or 0))), "smtp": smtp,
                    "issue_subscribers": division_subs,
                    "notification_events": notify.DIVISION_EVENT_LABELS}
        except Exception as e:
            return self._fail(e)

    def save_division_prefs(self, timezone=None, project_hub_url=None, device_os=None, hot_spare_depts=None, smtp=None, issue_subscribers=None, hot_spare_minimum=None, ot_lists=None, ot_stale_months=None) -> dict:
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
            if hot_spare_minimum is not None:
                try:
                    prefs_in["hot_spare_minimum"] = max(0, min(500, int(hot_spare_minimum)))
                except (TypeError, ValueError):
                    return {"ok": False, "error": "Enter a minimum between 0 and 500 devices."}
            if ot_lists is not None:
                try:
                    prefs_in["ot_lists"] = self._clean_ot_lists(ot_lists, strict=True)
                except ValueError as e:
                    return {"ok": False, "error": str(e)}
            if ot_stale_months is not None:
                try:
                    months = int(ot_stale_months)
                except (TypeError, ValueError):
                    months = 0
                if months not in (3, 6, 12, 24):
                    return {"ok": False, "error": "Choose a stale review period of 3, 6, 12, or 24 months."}
                prefs_in["ot_stale_months"] = months
            if smtp is not None:
                try:
                    prefs_in["smtp"] = sc.clean_smtp_settings(smtp)
                except ValueError as e:
                    return {"ok": False, "error": str(e)}
            if issue_subscribers is not None:
                import notify
                clean_subscribers = notify.division_subscribers_doc(issue_subscribers)
                if len(clean_subscribers) > 50:
                    return {"ok": False, "error": "At most 50 people can be on this division's notification list."}
                prefs_in["issue_subscribers"] = clean_subscribers
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
                route_gc = gc
                issue_division = (issue.get("division") or {}).get("id")
                if issue_division and issue_division != (gc.division or {}).get("id"):
                    route_gc = gc.clone_for_snapshot()
                    route_gc.set_division(issue_division, persist=False)
                from hub import hub_for
                division_subs = notify.division_subscribers_doc(hub_for(route_gc).get_prefs().get("issue_subscribers"))
                known = {x["upn"] for x in to}
                for recipient in notify.division_recipients(division_subs, event):
                    if recipient["upn"] != (actor.get("upn") or "").lower() and recipient["upn"] not in known:
                        to.append(recipient); known.add(recipient["upn"])
                if not to:
                    return
                subject, text, body = notify.render(issue, event, actor.get("name", ""), extra)
                res = notify.deliver(route_gc, to, subject, text, body, event, issue)
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

    def _notify_division_event(self, event: str, title: str, detail: str) -> None:
        """Send one division-scoped operational digest to opted-in people; never block the UI action."""
        import threading
        def run():
            try:
                import notify
                gc = self._client()
                prefs = self._hubc().get_prefs()
                to = notify.division_recipients(notify.division_subscribers_doc(prefs.get("issue_subscribers")), event)
                if not to:
                    return
                division = (gc.division or {}).get("name") or (gc.division or {}).get("id") or "Division"
                subject, body_text, body_html = notify.render_notice(division, title, detail, event)
                notify.deliver(gc, to, subject, body_text, body_html, event, {"title": title, "division": {"name": division}})
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
            smtp = gc.division_prefs().get("smtp") or {}
            smtp_ready = bool(smtp.get("enabled") and smtp.get("server") and smtp.get("from_address"))
            return {"ok": True, "super_admin": True, "subscribers": notify.subscribers_doc(hub.get_named("issue-subscribers")),
                    "events": issues.EVENTS, "webhook_set": bool(gc.get_setting("notify_webhook_url", "")),
                    "smtp_enabled": bool(smtp.get("enabled")), "smtp_ready": smtp_ready,
                    "can_mail": gc.can_send_mail()}
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
            div_subs = notify.division_subscribers_doc(self._hubc().get_prefs().get("issue_subscribers"))
            demo = issues.new_issue("bug", "Test notification", "This is a test from Settings > Issue notifications.", me,
                                    {"id": gc.division["id"], "name": gc.division.get("name", "")}, "")
            to = [{"upn": s["upn"], "name": s["name"]} for s in subs]
            known = {x["upn"] for x in to}
            for recipient in notify.division_recipients(div_subs, "new"):
                if recipient["upn"] not in known:
                    to.append(recipient); known.add(recipient["upn"])
            if not to:
                to = [{"upn": me["upn"], "name": me["name"]}]
            subject, text, body = notify.render(demo, "new", me["name"])
            res = notify.deliver(gc, to, subject, text, body, "new", demo)
            if res["sent"]:
                return {"ok": True, "sent": res["sent"], "via": res["via"]}
            return {"ok": False, "error": res["error"] or "Nothing was sent."}
        except Exception as e:
            return self._fail(e)

    def division_notify_test(self, event: str = "new") -> dict:
        """Send one selected sample notification to the signed-in user only."""
        try:
            import notify
            import issues
            gc = self._client()
            gc.sign_in(interactive=False)
            upn = (gc.account_upn or "").strip()
            if "@" not in upn:
                return {"ok": False, "error": "Could not identify your signed-in email address."}
            division = (gc.division or {}).get("name") or (gc.division or {}).get("id") or "Division"
            if event not in notify.DIVISION_EVENTS:
                return {"ok": False, "error": "Choose a notification type from the list."}
            if event in issues.EVENTS:
                me = issues.person(upn, gc.account_name)
                sample = issues.new_issue("bug", "Sample: " + notify.DIVISION_EVENT_LABELS[event],
                    "Sample email from Settings > General. No issue was created.", me,
                    {"id": gc.division["id"], "name": division}, "")
                extra = "Sample comment from NBG Hub." if event == "comment" else ""
                if event == "status":
                    sample["status"] = "in_progress"
                    sample["assignee"] = {"upn": upn, "name": gc.account_name or upn}
                subject, body_text, body_html = notify.render(sample, event, gc.account_name or upn, extra)
                delivery_record = sample
            else:
                samples = {
                    "boneyard": ("Sample Boneyard device summary", "Moved to Boneyard: SAMPLE-DEVICE [SAMPLE-SERIAL]\nRestored to Stock: none"),
                    "sharepoint": ("Sample SharePoint permission change", "Propagated permissions for Documents/Example Folder. Descendants reset: 4; skipped: 0; errors: 0."),
                    "software": ("Sample Not allowed software policy change", "Flagged not allowed: Sample App\nRemoved from not allowed: none"),
                    "ot": ("Sample OT asset review reminder", "OT assets need an information review. Open NBG Hub > OT Devices and filter for stale or missing information."),
                }
                title, detail = samples[event]
                subject, body_text, body_html = notify.render_notice(division, title, detail, event)
                delivery_record = {"title": title, "division": {"name": division}}
            result = notify.deliver(gc, [{"upn": upn}], subject, body_text, body_html, event, delivery_record)
            return {"ok": bool(result.get("sent")), "sent": result.get("sent", 0), "via": result.get("via", ""),
                    "error": result.get("error", "")}
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
            import divisions
            gc = self._client()
            d = gc.division
            keys = ("sites", "access", "ad_domain", "sql_server", "timesheet_db", "timesheet_table", "employee_db", "employee_table")
            companies = divisions.company_names(d)
            categories = divisions.intune_categories(d)
            return {"ok": True, "id": d["id"], "name": d.get("name", ""), "company_name": d.get("company_name", ""),
                    "intune_category": d.get("intune_category", ""), "super_admin": gc.is_super_admin(), "role": gc.division_role(),
                    "company_names": companies, "intune_categories": categories,
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
                    "has_snapshot": gc._ls().has_snapshot(), "can_switch": bool(gc.is_super_admin())}
        except Exception as e:
            return self._fail(e)

    def pull_prod_snapshot(self) -> dict:
        """READ-ONLY pull of production lists + hub folder into the local sandbox."""
        try:
            gc = self._client()
            if not gc.is_super_admin():
                return {"ok": False, "error": "Only a super admin can copy production data to this PC."}
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
            if mode == "local" and not gc.is_super_admin():          # going back to Live is always allowed
                return {"ok": False, "error": "Only a super admin can switch to a local copy."}
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
                who = f" ({gc.account_upn})" if gc.account_upn else ""
                return {"ok": False, "error": f"No division is available to this account{who}. Ask a super admin to check this exact sign-in in the division access list."}
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
            div = gc.division or {}
            return {"ok": True, "signed_in": True, "account": gc.account_name, "upn": gc.account_upn,
                    "object_id": gc.account_oid, "tenant_id": gc.account_tid,
                    "division": div.get("name", ""), "division_id": div.get("id", ""),
                    "role": gc.division_role(), "super_admin": gc.is_super_admin()}
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

    def sharepoint_permission_check(self) -> dict:
        """Check delegated SharePoint FullControl silently; never launch a consent prompt."""
        try:
            return {"ok": True, **self._client().sharepoint_permission_status()}
        except Exception as e:
            return self._fail(e)

    def sharepoint_sites_preferences_get(self) -> dict:
        """Read this user's saved site favorites, recents, and browse cache."""
        import json
        import paths
        path = os.path.join(paths.user_dir(), "sharepoint_sites.json")
        try:
            with open(path, encoding="utf-8") as f:
                value = json.load(f)
            if isinstance(value, dict):
                return {"ok": True, **value}
        except FileNotFoundError:
            pass
        except Exception as e:
            return {"ok": False, "error": f"Could not read saved SharePoint sites: {e}"}
        return {"ok": True, "favorites": [], "recents": [], "site_index": None}

    def sharepoint_sites_preferences_save(self, data: dict) -> dict:
        """Persist site shortcuts outside WebView storage, which runs in private mode."""
        import json
        import paths
        from urllib.parse import urlsplit

        def clean_sites(rows, limit):
            clean = []
            for item in rows if isinstance(rows, list) else []:
                if not isinstance(item, dict):
                    continue
                url = str(item.get("url") or "").strip()[:1200]
                title = str(item.get("title") or "").strip()[:200]
                try:
                    host = (urlsplit(url).hostname or "").lower()
                except ValueError:
                    continue
                if urlsplit(url).scheme != "https" or not host.endswith(".sharepoint.com") or not title:
                    continue
                clean.append({"title": title, "url": url, "logo": str(item.get("logo") or "")[:2000]})
                if len(clean) >= limit:
                    break
            return clean

        try:
            value = data if isinstance(data, dict) else {}
            site_index = value.get("site_index") if isinstance(value.get("site_index"), dict) else None
            cache = None
            if site_index:
                try:
                    next_start = site_index.get("next_start")
                    next_start = int(next_start) if next_start is not None else None
                    total = max(0, min(1000000, int(site_index.get("total") or 0)))
                except (TypeError, ValueError):
                    next_start, total = None, 0
                cache = {"sites": clean_sites(site_index.get("sites"), 500), "next_start": next_start, "total": total}
            saved = {
                "favorites": clean_sites(value.get("favorites"), 200),
                "recents": clean_sites(value.get("recents"), 8),
                "site_index": cache,
            }
            path = os.path.join(paths.user_dir(), "sharepoint_sites.json")
            temp_path = path + ".tmp"
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(saved, f, ensure_ascii=False)
            os.replace(temp_path, path)
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    def sharepoint_permissions_default_site(self) -> dict:
        """Return the active division's configured SharePoint site URL for the page default."""
        try:
            gc = self._client()
            division = gc.division or {}
            host = str(division.get("sharepoint_hostname") or gc.cfg.get("sharepoint_hostname") or "").strip().strip("/")
            path = str(division.get("site_path") or gc.cfg.get("site_path") or "").strip()
            if not host:
                return {"ok": False, "error": "SharePoint host is not configured for this division."}
            return {"ok": True, "site_url": f"https://{host}/{path.lstrip('/')}" if path else f"https://{host}"}
        except Exception as e:
            return self._fail(e)

    def sharepoint_permissions_search_sites(self, query: str = "", start: int = 0) -> dict:
        """Search SharePoint's index for site collections under /sites on the active host."""
        try:
            gc = self._client()
            host = str(gc.cfg.get("sharepoint_hostname") or "")
            token = gc.sharepoint_rest_access_token()
            import sharepoint_permissions
            return {"ok": True, **sharepoint_permissions.search_sites(host, token, query, start)}
        except Exception as e:
            return self._fail(e)

    def sharepoint_permissions_browse_content(self, site_url: str, folder_path: str = "", list_id: str = "") -> dict:
        """Browse document libraries and immediate child folders; does not read permissions."""
        try:
            gc = self._client()
            import sharepoint_permissions
            return {"ok": True, **sharepoint_permissions.browse_content(
                site_url, str(gc.cfg.get("sharepoint_hostname") or ""),
                gc.sharepoint_rest_access_token(), folder_path, list_id)}
        except Exception as e:
            return self._fail(e)

    def sharepoint_permissions_prepare_inheritance(self, site_url: str, list_id: str, parent_path: str) -> dict:
        """Read all unique descendants and stage a reviewable inheritance plan."""
        import time
        import uuid
        try:
            with self._work():
                gc = self._client()
                import sharepoint_permissions
                plan = sharepoint_permissions.prepare_inheritance_reset(
                    site_url, str(gc.cfg.get("sharepoint_hostname") or ""),
                    gc.sharepoint_rest_access_token(), list_id, parent_path)
            plan_id = uuid.uuid4().hex
            with self._spm_inheritance_lock:
                now = time.time()
                self._spm_inheritance_plans = {key: value for key, value in self._spm_inheritance_plans.items()
                                               if now - value["created"] < 1800}
                self._spm_inheritance_plans[plan_id] = {"created": now, "plan": plan}
            preview = [{"path": target["path"], "type": target["type"],
                        "grants": len(target["assignments"]), "sharing_links": target["sharing_links"],
                        "access": [f"{principal.get('title') or principal.get('login')}: {principal.get('level') or 'role'}"
                                   for principal in target["assignments"]]}
                       for target in plan["targets"]]
            return {"ok": True, "plan_id": plan_id, "site_url": plan["site_url"],
                    "library_title": plan["library_title"], "parent_path": plan["parent_path"],
                    "target_count": len(preview), "sharing_link_targets": plan["sharing_link_targets"],
                    "principal_grants": plan["principal_grants"], "targets": preview}
        except Exception as e:
            return self._fail(e)

    def sharepoint_permissions_apply_inheritance(self, plan_id: str, confirmed: bool = False) -> dict:
        """Apply a previously reviewed plan only after explicit user confirmation."""
        if confirmed is not True:
            return {"ok": False, "error": "Confirm the reviewed inheritance plan before applying it."}
        try:
            with self._spm_inheritance_lock:
                record = self._spm_inheritance_plans.pop(str(plan_id or ""), None)
            if not record or time.time() - record["created"] >= 1800:
                return {"ok": False, "error": "This preview expired. Build a fresh inheritance preview."}
            gc = self._client()
            import sharepoint_permissions
            with self._work():
                result = sharepoint_permissions.apply_inheritance_reset(
                    record["plan"]["site_url"], str(gc.cfg.get("sharepoint_hostname") or ""),
                    gc.sharepoint_rest_access_token(), record["plan"])
            plan = record["plan"]
            detail = (f"Folder/library: {plan.get('library_title', '')}/{plan.get('parent_path', '')}\n"
                      f"Descendants reset: {len(result.get('applied', []))}; skipped: {len(result.get('skipped', []))}; errors: {len(result.get('errors', []))}")
            self._audit("SharePoint permissions propagated", detail)
            if result.get("applied"):
                self._notify_division_event("sharepoint", "SharePoint permissions propagated", detail)
            return {"ok": True, **result}
        except Exception as e:
            return self._fail(e)

    def sharepoint_permissions_prepare_copy(self, site_url: str, source_list_id: str, source_path: str,
                                            target_list_id: str, target_path: str) -> dict:
        """Read source and destination ACLs, then stage a reviewable copy plan."""
        import time
        import uuid
        try:
            with self._work():
                gc = self._client()
                import sharepoint_permissions
                plan = sharepoint_permissions.prepare_permission_copy(
                    site_url, str(gc.cfg.get("sharepoint_hostname") or ""),
                    gc.sharepoint_rest_access_token(), source_list_id, source_path,
                    target_list_id, target_path)
            plan_id = uuid.uuid4().hex
            with self._spm_copy_lock:
                now = time.time()
                self._spm_copy_plans = {key: value for key, value in self._spm_copy_plans.items()
                                        if now - value["created"] < 1800}
                self._spm_copy_plans[plan_id] = {"created": now, "plan": plan}
            source, target = plan["source"], plan["target"]
            descendants = plan["descendants"]
            links_not_copied = sum(1 for item in source["assignments"] if item.get("sharing_link"))
            return {"ok": True, "plan_id": plan_id, "source_path": source["path"],
                    "source_library": source["title"], "target_path": target["path"],
                    "target_library": target["title"], "source_grants": [
                        {"title": row.get("title") or row.get("login"), "level": row.get("level"),
                         "sharing_link": bool(row.get("sharing_link")),
                         "operator_preserved": int(row.get("principal_id") or row.get("id") or 0) == int(plan.get("operator_id") or 0)}
                        for row in source["assignments"]],
                    "target_grants": [{"title": row.get("title") or row.get("login"),
                                       "level": row.get("level"),
                                       "sharing_link": bool(row.get("sharing_link")),
                                       "operator_preserved": int(row.get("principal_id") or row.get("id") or 0) == int(plan.get("operator_id") or 0)}
                                      for row in target["assignments"]],
                    "target_grant_count": len(target["assignments"]),
                    "target_sharing_links": sum(1 for row in target["assignments"] if row.get("sharing_link")),
                    "descendant_count": len(descendants),
                    "descendants": [{"path": row["path"], "type": row["type"],
                                     "grants": len(row["assignments"]),
                                     "sharing_links": sum(1 for item in row["assignments"] if item.get("sharing_link"))}
                                    for row in descendants],
                    "descendant_sharing_links": sum(1 for row in descendants
                        if any(item.get("sharing_link") for item in row["assignments"])),
                    "source_links_not_copied": links_not_copied}
        except Exception as e:
            return self._fail(e)

    def sharepoint_permissions_apply_copy(self, plan_id: str, confirmed: bool = False) -> dict:
        """Apply a previously reviewed permission copy only after explicit confirmation."""
        if confirmed is not True:
            return {"ok": False, "error": "Confirm the reviewed permission-copy plan before applying it."}
        try:
            with self._spm_copy_lock:
                record = self._spm_copy_plans.pop(str(plan_id or ""), None)
            if not record or time.time() - record["created"] >= 1800:
                return {"ok": False, "error": "This preview expired. Build a fresh permission-copy preview."}
            gc = self._client()
            import sharepoint_permissions
            with self._work():
                result = sharepoint_permissions.apply_permission_copy(
                    record["plan"]["site_url"], str(gc.cfg.get("sharepoint_hostname") or ""),
                    gc.sharepoint_rest_access_token(), record["plan"])
            plan = record["plan"]
            source, target = plan.get("source", {}), plan.get("target", {})
            detail = (f"Copied from {source.get('title', '')}/{source.get('path', '')} to "
                      f"{target.get('title', '')}/{target.get('path', '')}. "
                      f"Descendants reset: {len(result.get('descendants_reset', []))}; grants added: {result.get('grants_added', 0)}; "
                      f"errors: {len(result.get('errors', []))}")
            self._audit("SharePoint permissions copied", detail)
            if result.get("grants_added") or result.get("descendants_reset"):
                self._notify_division_event("sharepoint", "SharePoint permissions copied", detail)
            return {"ok": True, **result}
        except Exception as e:
            return self._fail(e)

    def sharepoint_permissions_prepare_remove_links(self, site_url: str, targets: list) -> dict:
        """Re-read and stage only existing sharing-link permissions for review."""
        import uuid
        try:
            if not isinstance(targets, list) or not targets or len(targets) > 10000:
                raise ValueError("Select one or more sharing links to remove.")
            gc = self._client()
            plan_targets, total = [], 0
            seen = set()
            with self._work():
                for target in targets:
                    if not isinstance(target, dict):
                        continue
                    list_id = str(target.get("list_id") or "").strip()
                    try:
                        item_id = int(target.get("item_id"))
                    except (TypeError, ValueError):
                        continue
                    raw_permission_ids = target.get("permission_ids", [])
                    if not isinstance(raw_permission_ids, list):
                        continue
                    permission_ids = {str(value).strip() for value in raw_permission_ids if str(value).strip()}
                    if not list_id or not permission_ids:
                        continue
                    key = (list_id, item_id)
                    if key in seen:
                        continue
                    seen.add(key)
                    live_links = gc.sharepoint_item_sharing_links(site_url, list_id, item_id)
                    matches = [link for link in live_links if link.get("permission_id") in permission_ids]
                    if matches:
                        plan_targets.append({"list_id": list_id, "item_id": item_id,
                                             "library": str(target.get("library") or ""),
                                             "path": str(target.get("path") or ""),
                                             "links": matches})
                        total += len(matches)
            if not total:
                raise ValueError("Selected links are no longer present. Rescan the site.")
            plan_id = uuid.uuid4().hex
            with self._spm_link_lock:
                now = time.time()
                self._spm_link_plans = {key: value for key, value in self._spm_link_plans.items()
                                        if now - value["created"] < 1800}
                self._spm_link_plans[plan_id] = {"created": now, "site_url": str(site_url),
                                                 "targets": plan_targets}
            return {"ok": True, "plan_id": plan_id, "link_count": total,
                    "item_count": len(plan_targets),
                    "targets": [{"library": row["library"], "path": row["path"],
                                 "links": [{"scope": link.get("scope"), "type": link.get("type"),
                                            "roles": link.get("roles", []),
                                            "expiration": link.get("expiration", "")}
                                           for link in row["links"]]}
                                for row in plan_targets]}
        except Exception as e:
            return self._fail(e)

    def sharepoint_permissions_apply_remove_links(self, plan_id: str, confirmed: bool = False) -> dict:
        """Revalidate and revoke reviewed sharing links; report partial failures by item."""
        if confirmed is not True:
            return {"ok": False, "error": "Confirm the reviewed sharing-link removal before applying."}
        try:
            with self._spm_link_lock:
                record = self._spm_link_plans.pop(str(plan_id or ""), None)
            if not record or time.time() - record["created"] >= 1800:
                return {"ok": False, "error": "This preview expired. Rescan and review the links again."}
            gc = self._client()
            removed, failed = [], []
            with self._work():
                for target in record["targets"]:
                    for link in target["links"]:
                        try:
                            gc.delete_sharepoint_item_sharing_link(
                                record["site_url"], target["list_id"], target["item_id"],
                                link.get("permission_id", ""))
                            removed.append({"library": target["library"], "path": target["path"]})
                        except Exception as exc:
                            failed.append({"library": target["library"], "path": target["path"],
                                           "error": str(exc)})
            if removed:
                paths = list(dict.fromkeys(f"{x['library']}/{x['path']}" for x in removed))
                detail = f"Revoked sharing links from {len(removed)} item(s): " + ", ".join(paths[:20])
                self._audit("SharePoint sharing links revoked", detail)
                self._notify_division_event("sharepoint", "SharePoint sharing links revoked", detail)
            return {"ok": True, "removed": removed, "failed": failed}
        except Exception as e:
            return self._fail(e)

    def sharepoint_permissions_scan(self, site_url: str, scan_id: str = "", scopes=None) -> dict:
        """Read-only scan for unique permissions on a site or selected folder trees."""
        import uuid
        scan_id = str(scan_id or uuid.uuid4().hex)
        cancel_event = threading.Event()
        state = {"scan_id": scan_id, "phase": "Starting scan", "done": False,
                 "cancel_requested": False, "libraries_done": 0, "libraries_total": 0,
                 "items_scanned": 0, "permissions_done": 0, "permissions_total": 0}
        with self._spm_scans_lock:
            for old_id in list(self._spm_scans):
                if len(self._spm_scans) < 20:
                    break
                old = self._spm_scans[old_id]
                if old["state"].get("done"):
                    self._spm_scans.pop(old_id, None)
            self._spm_scans[scan_id] = {"state": state, "cancel": cancel_event}

        def update_progress(update):
            with self._spm_scans_lock:
                record = self._spm_scans.get(scan_id)
                if record:
                    state = record["state"]
                    updates = dict(update)
                    recent_items = updates.pop("recent_items", None)
                    state.update(updates)
                    if recent_items:
                        rows = state.setdefault("recent_items", [])
                        rows.extend(recent_items)
                        # Progress polling needs a small live preview, not a second copy
                        # of every library item. Keep only newest paths from recent pages.
                        by_path = {}
                        for row in rows:
                            by_path[(row.get("library", "") + "|" + row.get("display_path", "")).casefold()] = row
                        state["recent_items"] = list(by_path.values())[-24:]

        import sharepoint_permissions
        try:
            gc = self._client()
            host = str(gc.cfg.get("sharepoint_hostname") or "")
            token = gc.sharepoint_rest_access_token()
            result = sharepoint_permissions.scan(site_url, host, token,
                                                 progress=update_progress, cancel_event=cancel_event,
                                                 scopes=scopes,
                                                 graph_group_members=gc.entra_group_members,
                                                 graph_sharing_links=gc.sharepoint_item_sharing_links)
            return {"ok": True, **result}
        except sharepoint_permissions.SharePointScanCancelled:
            return {"ok": False, "cancelled": True, "error": "SharePoint scan cancelled."}
        except Exception as e:
            return self._fail(e)
        finally:
            with self._spm_scans_lock:
                record = self._spm_scans.get(scan_id)
                if record:
                    record["state"]["done"] = True
                    record["state"]["cancelled"] = cancel_event.is_set()

    def sharepoint_permissions_export_excel(self, scan_data: dict) -> dict:
        """Create an offline XLSX report from the current SharePoint scan."""
        try:
            import sharepoint_permissions
            if not isinstance(scan_data, dict) or not isinstance(scan_data.get("entries"), list):
                raise ValueError("Scan data is missing or invalid. Run the scan again.")
            return sharepoint_permissions.export_xlsx(scan_data)
        except Exception as e:
            return self._fail(e)

    def save_csv_file(self, filename: str, content: str) -> dict:
        """Show a native Save As dialog and write a CSV selected by the user."""
        try:
            import webview
            if self._window is None:
                raise RuntimeError("Save As is available from the NBG Hub desktop app.")
            name = os.path.basename(str(filename or "NBG-Hub-export.csv"))
            if not name.lower().endswith(".csv"):
                name += ".csv"
            selected = self._window.create_file_dialog(
                webview.FileDialog.SAVE,
                directory=os.path.join(os.path.expanduser("~"), "Downloads"),
                save_filename=name,
                file_types=("CSV files (*.csv)",),
            )
            if not selected:
                return {"ok": True, "cancelled": True}
            path = selected[0] if isinstance(selected, (tuple, list)) else selected
            if not path:
                return {"ok": True, "cancelled": True}
            with open(path, "w", encoding="utf-8", newline="") as stream:
                stream.write(str(content or ""))
            return {"ok": True, "path": path}
        except Exception as e:
            return self._fail(e)

    def sharepoint_permissions_scan_status(self, scan_id: str) -> dict:
        with self._spm_scans_lock:
            record = self._spm_scans.get(str(scan_id or ""))
            if not record:
                return {"ok": False, "error": "SharePoint scan status expired."}
            return {"ok": True, "progress": dict(record["state"])}

    def sharepoint_permissions_cancel_scan(self, scan_id: str) -> dict:
        with self._spm_scans_lock:
            record = self._spm_scans.get(str(scan_id or ""))
            if not record:
                return {"ok": False, "error": "SharePoint scan is no longer running."}
            if record["state"].get("done"):
                return {"ok": False, "error": "SharePoint scan has already finished."}
            record["state"]["cancel_requested"] = True
            record["cancel"].set()
            return {"ok": True}

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

    def get_device_last_reboot(self, serial: str) -> dict:
        """Read latest Intune-reported boot time when a device row is expanded."""
        try:
            value = self._client().intune_last_reboot(serial or "")
            return {"ok": True, "last_reboot": value}
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
            if not row.get("deploy_date"):
                row["deploy_date"] = __import__("datetime").date.today().isoformat()
            gc.add_in_use(row)
            gc.delete_item("new_stock", item["id"])
            details = f"Assigned to {user.strip()}." + (f" Reason: {reason.strip()}" if reason.strip() else "")
            gc.add_log("Deployed", serial, row.get("model", ""), actor=gc.account_name or "", details=details)
            return {"ok": True, "message": f"{serial} deployed to {user.strip()}."}
        except Exception as e:
            return self._fail(e)

    # ---- Activity: one place to see what people did ----
    def _audit(self, target: str, detail: str, scope: str = "division") -> None:
        """Record who did what in the shared change feed (best effort; never raises, never holds secrets)."""
        try:
            from hub import platform_hub_for
            gc = self._client()
            h = platform_hub_for(gc) if scope == "platform" else self._hubc()
            h._change(target, detail, actor=self._actor() or None)
        except Exception:
            pass

    def activity_get(self, days: int = 0) -> dict:
        """Everything recorded in the last `days` days (0 = all): device events, division changes, platform changes. Admins only."""
        try:
            import activity
            from hub import platform_hub_for
            gc = self._client()
            if gc.division_role() not in ("super", "admin"):
                return {"ok": False, "error": "The activity log is for admins."}
            try:
                inv = gc.get_log(top=1500)
            except Exception:
                inv = []
            try:
                div = self._hubc().get_changes()
            except Exception:
                div = []
            sa = gc.is_super_admin()
            plat = []
            if sa:                                    # platform changes (roles, super admins, settings, sign-ins) are for super admins only
                try:
                    plat = platform_hub_for(gc).get_changes()
                except Exception:
                    plat = []
            return {"ok": True, "platform": sa, **activity.build(inv, div, plat, int(days or 0))}
        except Exception as e:
            return self._fail(e)

    # ---- in-use device ownership classification: shared metadata keyed by serial ----
    def device_classifications_get(self) -> dict:
        try:
            gc = self._client()
            doc = self._hubc().get_named("device-classifications") or {}
            return {"ok": True, "data": doc.get("classifications") or {},
                    "can_edit": gc.division_role() in ("super", "admin")}
        except Exception as e:
            return self._fail(e)

    def device_classification_set(self, serial: str, classification: str) -> dict:
        """Mark an unassigned in-use device as shared, or return it to Needs owner."""
        try:
            gc = self._client()
            gc.require_division_admin()
            serial = str(serial or "").strip()
            classification = str(classification or "").strip().lower()
            if not serial or len(serial) > 100:
                return {"ok": False, "error": "Choose a valid device."}
            if classification not in ("shared", "needs_owner"):
                return {"ok": False, "error": "Choose Shared machine or Needs owner."}
            item = gc.find_by_serial("in_use", serial)
            if not item:
                return {"ok": False, "error": "Device is no longer in the In Use list. Refresh and try again."}
            row = gc._row(item["fields"], "in_use", in_use=True)
            if (row.get("user") or "").strip():
                return {"ok": False, "error": "This device now has a primary user. Refresh and try again."}

            h = self._hubc()
            for attempt in range(3):
                try:
                    doc = h.get_named("device-classifications") or {}
                    classifications = dict(doc.get("classifications") or {})
                    key = serial.lower()
                    if classification == "shared":
                        classifications[key] = "shared"
                    else:
                        classifications.pop(key, None)  # blank / missing owner defaults to Needs owner
                    h.put_named("device-classifications", {"classifications": classifications})
                    break
                except Exception as ce:
                    if ce.__class__.__name__ != "HubConflict" or attempt == 2:
                        raise
            label = "Shared machine" if classification == "shared" else "Needs owner"
            try:
                h._change("Device classification", f"{self._actor() or 'NBG Hub'}: {serial} marked {label}.")
            except Exception:
                pass
            return {"ok": True, "classification": classification, "data": classifications}
        except Exception as e:
            return self._fail(e)

    # ---- device custody and Intune snapshot history ----------------------
    def device_lifecycle_get(self, serial: str = "") -> dict:
        try:
            import hashlib
            hub = self._hubc(); serial = str(serial or "").strip()
            if serial:
                key = hashlib.sha256(serial.lower().encode()).hexdigest()[:32]
                return {"ok": True, "device": hub.get_named("device-lifecycle-" + key) or {}}
            doc = hub.get_named("device-lifecycle-index") or {}
            return {"ok": True, "devices": doc.get("devices") or {}}
        except Exception as e:
            return self._fail(e)

    def device_checkout(self, serial: str, custodian: str, due_date: str = "", notes: str = "") -> dict:
        """Record custody separately from Intune's authoritative primary user."""
        try:
            import datetime
            gc = self._client(); gc.sign_in(interactive=False)
            serial = str(serial or "").strip(); custodian = str(custodian or "").strip()
            if not serial or not custodian or len(custodian) > 160:
                return {"ok": False, "error": "Choose a device and enter its checkout custodian."}
            if due_date:
                datetime.date.fromisoformat(due_date)
            row = gc.find_by_serial("in_use", serial) or gc.find_by_serial("new_stock", serial)
            if not row:
                return {"ok": False, "error": "Device is no longer in inventory. Refresh and try again."}
            import hashlib
            hub = self._hubc(); doc = hub.get_named("device-lifecycle-index") or {}; devices = dict(doc.get("devices") or {})
            key = serial.lower(); doc_key = hashlib.sha256(key.encode()).hexdigest()[:32]
            state = dict(hub.get_named("device-lifecycle-" + doc_key) or {})
            if state.get("status") == "checked_out":
                return {"ok": False, "error": f"Device is already checked out to {state.get('custodian') or 'another custodian'}. Record its return first."}
            event = {"at": __import__("datetime").datetime.now().astimezone().isoformat(), "by": self._actor() or gc.account_upn or "Hub user",
                     "action": "checked out", "custodian": custodian, "due_date": due_date, "notes": str(notes or "")[:1000]}
            state.update({"custodian": custodian, "checked_out_at": event["at"], "due_date": due_date, "status": "checked_out"})
            state["history"] = (list(state.get("history") or []) + [event])[-100:]
            hub.put_named("device-lifecycle-" + doc_key, state)
            for attempt in range(3):
                try:
                    index = hub.get_named("device-lifecycle-index") or {}; devices = dict(index.get("devices") or {})
                    devices[key] = {k: state.get(k, "") for k in ("status", "custodian", "checked_out_at", "due_date")}
                    hub.put_named("device-lifecycle-index", {"devices": devices})
                    break
                except Exception as e:
                    if e.__class__.__name__ != "HubConflict" or attempt == 2: raise
            gc.add_log("Device checked out", serial, "", actor=event["by"], details=f"Custodian: {custodian}" + (f" · Due: {due_date}" if due_date else ""))
            self._notify_division_event("device", f"Device checked out: {serial}", f"Custodian: {custodian}\nDue date: {due_date or 'Not set'}\nNotes: {event['notes'] or 'None'}")
            return {"ok": True, "device": state}
        except Exception as e:
            return self._fail(e)

    def device_return(self, serial: str, notes: str = "") -> dict:
        try:
            gc = self._client(); gc.sign_in(interactive=False)
            serial = str(serial or "").strip(); hub = self._hubc()
            import hashlib
            key = serial.lower(); doc_key = hashlib.sha256(key.encode()).hexdigest()[:32]
            state = dict(hub.get_named("device-lifecycle-" + doc_key) or {})
            if not serial or state.get("status") != "checked_out":
                return {"ok": False, "error": "This device has no active checkout."}
            old = state.get("custodian") or "Unknown"
            event = {"at": __import__("datetime").datetime.now().astimezone().isoformat(), "by": self._actor() or gc.account_upn or "Hub user",
                     "action": "returned", "custodian": old, "notes": str(notes or "")[:1000]}
            state.update({"status": "available", "custodian": "", "due_date": "", "returned_at": event["at"]})
            state["history"] = (list(state.get("history") or []) + [event])[-100:]
            hub.put_named("device-lifecycle-" + doc_key, state)
            for attempt in range(3):
                try:
                    index = hub.get_named("device-lifecycle-index") or {}; devices = dict(index.get("devices") or {})
                    devices[key] = {k: state.get(k, "") for k in ("status", "custodian", "checked_out_at", "due_date")}
                    hub.put_named("device-lifecycle-index", {"devices": devices})
                    break
                except Exception as e:
                    if e.__class__.__name__ != "HubConflict" or attempt == 2: raise
            gc.add_log("Device returned", serial, "", actor=event["by"], details=f"Returned by {old}" + (f" · {event['notes']}" if event["notes"] else ""))
            self._notify_division_event("device", f"Device returned: {serial}", f"Returned by: {old}\nNotes: {event['notes'] or 'None'}")
            return {"ok": True, "device": state}
        except Exception as e:
            return self._fail(e)

    def saved_reports_get(self) -> dict:
        try:
            doc = self._hubc().get_named("saved-reports") or {}
            return {"ok": True, "reports": doc.get("reports") or []}
        except Exception as e:
            return self._fail(e)

    def saved_reports_save(self, reports: list) -> dict:
        try:
            gc = self._client(); gc.sign_in(interactive=False)
            if not (gc.account_upn or "").strip(): return {"ok": False, "error": "Sign in to save division reports."}
            clean = []
            for item in (reports or [])[:50]:
                if not isinstance(item, dict) or not str(item.get("name") or "").strip(): continue
                clean.append({"id": str(item.get("id") or "")[:80], "name": str(item["name"]).strip()[:80],
                              "filters": item.get("filters") if isinstance(item.get("filters"), dict) else {},
                              "updated_at": __import__("datetime").datetime.now().astimezone().isoformat()})
            self._hubc().put_named("saved-reports", {"reports": clean})
            return {"ok": True, "reports": clean}
        except Exception as e:
            return self._fail(e)

    def sharepoint_review_get(self, site_url: str) -> dict:
        try:
            key = __import__("hashlib").sha256(str(site_url or "").strip().lower().encode()).hexdigest()[:32]
            doc = self._hubc().get_named("sharepoint-review-plans") or {}
            return {"ok": True, "items": (doc.get("sites") or {}).get(key) or []}
        except Exception as e:
            return self._fail(e)

    def sharepoint_review_save(self, site_url: str, items: list) -> dict:
        try:
            gc = self._client(); gc.require_division_admin()
            url = str(site_url or "").strip()
            if not url.lower().startswith("https://") or len(items or []) > 250:
                return {"ok": False, "error": "Review plan needs a valid site and at most 250 findings."}
            key = __import__("hashlib").sha256(url.lower().encode()).hexdigest()[:32]
            hub = self._hubc(); doc = hub.get_named("sharepoint-review-plans") or {}; sites = dict(doc.get("sites") or {})
            sites[key] = (items or [])[:250]; hub.put_named("sharepoint-review-plans", {"sites": sites})
            return {"ok": True, "items": sites[key]}
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
            col_ok = 0
            try:                                          # the list columns are the main copy; the hub document stays as the fallback
                col_ok = self._client().set_row_dates_bulk({s: (dep, mf) for s in sn})
            except Exception:
                pass
            try:
                bits = (f"deploy date {dep or 'cleared'}" if dep is not None else "") + (", " if dep is not None and mf is not None else "") + (f"manufacture date {mf or 'cleared'}" if mf is not None else "")
                h._change("Device dates", f"{self._actor() or 'NBG Hub'}: {bits} on {len(sn)} device(s)" + (f" ({', '.join(sn[:5])})" if len(sn) <= 5 else ""))
            except Exception:
                pass
            return {"ok": True, "data": dates, "columns": col_ok}
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
                "deploy_date": row.get("deploy_date", ""), "mfg_date": row.get("mfg_date", ""),
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

    # ---- Windows Update Watch --------------------------------------------
    def windows_updates_get(self) -> dict:
        """Read the latest division-scoped Windows update snapshot."""
        try:
            data = self._hubc().get_named("windows-update-watch") or {}
            return {"ok": True, "data": data}
        except Exception as e:
            return self._fail(e)

    def windows_updates_refresh(self) -> dict:
        """Refresh Intune devices and Microsoft security update catalog for this division."""
        try:
            gc = self._client()
            if getattr(gc, "data_mode", "live") == "local":
                return {"ok": False, "error": "Switch to Live data to refresh Windows Update Watch from Intune."}
            data = gc.windows_update_watch()
            data["by"] = self._actor() or getattr(gc, "account_upn", "")
            self._hubc().put_named("windows-update-watch", data)
            return {"ok": True, "data": data}
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
            previous_blocked = list((h.get_software_rules() or {}).get("not_allowed") or [])
            if "auto" in rules:
                new = self._clean_sw_auto(rules["auto"])
                cur = self._clean_sw_auto((h.get_software_rules() or {}).get("auto"))
                if new != cur and self._client().division_role() not in ("super", "admin"):
                    return {"ok": False, "error": "Only division admins can change the automatic mandatory-app rules."}
                rules["auto"] = new
            saved = h.save_software_rules(rules, self._actor())
            current_blocked = list(saved.get("not_allowed") or [])
            before = {x.casefold() for x in previous_blocked}
            after = {x.casefold() for x in current_blocked}
            added, removed = [x for x in current_blocked if x.casefold() not in before], [x for x in previous_blocked if x.casefold() not in after]
            if added or removed:
                parts = []
                if added: parts.append("Flagged not allowed: " + ", ".join(added[:30]))
                if removed: parts.append("Removed from not allowed: " + ", ".join(removed[:30]))
                self._notify_division_event("software", "Not allowed software policy changed", "\n".join(parts))
            return {"ok": True, **saved}
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
            raw_depts = dept_map.get((r.get("model") or "").strip()) or []
            depts = raw_depts if isinstance(raw_depts, list) else [raw_depts]
            for dep in [str(d).strip() for d in depts if str(d).strip()] or ["Unassigned"]:
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
        intune, entra, entra_state, intune_ok, intune_error = {}, {}, "off", False, ""
        try:
            gc = self._client()
            gc.sign_in(interactive=False)
            try:
                intune = gc.intune_presence_map(serials)   # any-category, by serial
                intune_ok = True
            except Exception as exc:
                intune = {}
                intune_error = str(exc)
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
                "intune_error": intune_error, "ad_error": ad_error,
                "ad_domain": (self._client().cfg.get("ad_domain") or "")}

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
                          "deploy_date": row.get("deploy_date", ""), "mfg_date": row.get("mfg_date", ""),
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
        _bg = [r for r in in_use if _fresh(r) and (r.get("device_name") or "").strip().upper().startswith("BG") and (r.get("serial") or "").strip()]
        controls = (_bg or [r for r in in_use if _fresh(r) and (r.get("device_name") or "").strip() and (r.get("serial") or "").strip()])[:8]
        control_serials = {(r.get("serial") or "").strip().upper() for r in controls}

        checkset = [{"serial": r.get("serial", ""), "hostname": r.get("device_name", "")} for r in candidates]
        checkset += [{"serial": r.get("serial", ""),
                      "hostname": snaps.get((r.get("serial") or "").strip().upper(), {}).get("device_name", "")}
                     for r in boneyard_rows]
        checkset += [{"serial": r.get("serial", ""), "hostname": r.get("device_name", "")} for r in controls]
        if not candidates and not boneyard_rows:
            return {"ok": True, "added": [], "restored": [], "dry_run": dry_run}
        if not controls:
            return {"ok": True, "added": [], "restored": [], "skipped": "No recent control device; source checks cannot be validated."}
        if any(not (r.get("serial") or "").strip() or not (r.get("device_name") or "").strip() for r in candidates):
            return {"ok": True, "added": [], "restored": [], "skipped": "A stale candidate is missing serial number or device name."}
        if any(not (r.get("serial") or "").strip() or not snaps.get((r.get("serial") or "").strip().upper(), {}).get("device_name") for r in boneyard_rows):
            return {"ok": True, "added": [], "restored": [], "skipped": "A Boneyard device is missing its saved serial number or device name."}
        loc = self.locate_devices(checkset)
        # Safety guards — if any source couldn't be checked, do nothing.
        if loc.get("ad_error"):
            return {"ok": True, "skipped": "AD unavailable: " + str(loc["ad_error"]), "added": [], "restored": []}
        if loc.get("entra_state") != "on":
            return {"ok": True, "skipped": "Entra not checkable (" + str(loc.get("entra_state")) + ")", "added": [], "restored": []}
        if not loc.get("intune_ok"):
            return {"ok": True, "skipped": "Intune query failed: " + str(loc.get("intune_error") or "unknown error"), "added": [], "restored": []}
        by = {(d.get("serial") or "").strip().upper(): d for d in loc.get("devices", [])}
        # Authoritativeness: AD must find at least one known-active control device,
        # else its cn= lookups aren't reliable right now -> don't trust any "not found".
        if not any((by.get(s) or {}).get("in_ad") for s in control_serials):
            return {"ok": True, "added": [], "restored": [],
                    "skipped": "AD lookups not returning known-active devices — not trusting 'not found' this run."}
        added, restored, now = [], [], datetime.now().isoformat()
        for r in candidates:
            d = by.get((r.get("serial") or "").strip().upper())
            if d and not d["in_ad"] and not d["in_entra"] and not d["in_intune"]:
                if not dry_run:
                    moved = self._boneyard_move(gc, r.get("serial", ""), {
                        "device_name": r.get("device_name", ""), "user": r.get("user", ""),
                        "last_checkin": r.get("last_checkin", ""), "model": r.get("model", ""),
                        "site": r.get("site_tag", ""), "moved_at": now,
                        "moved_by": gc.account_name or "auto-sync",
                        "reason": "Not in AD, Entra, or Intune"})
                    if not moved:
                        continue
                added.append({"serial": r.get("serial", ""), "device_name": r.get("device_name", ""), "model": r.get("model", "")})
        for r in boneyard_rows:
            d = by.get((r.get("serial") or "").strip().upper())
            if d and (d["in_ad"] or d["in_entra"] or d["in_intune"]):
                if not dry_run:
                    outcome = self.restore_boneyard(r.get("serial", ""))
                    if not outcome.get("ok"):
                        continue
                restored.append({"serial": r.get("serial", "")})
        if not dry_run and (added or restored):
            changes = []
            if added: changes.append(f"Moved to Boneyard ({len(added)}): " + ", ".join(f"{d['device_name']} [{d['serial']}]" for d in added[:20]))
            if restored: changes.append(f"Restored to Stock ({len(restored)}): " + ", ".join(x["serial"] for x in restored[:20]))
            self._notify_division_event("boneyard", "Boneyard device changes", "\n".join(changes))
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
    def coil_card_info(self) -> dict:
        """Whether the Coil Cards heading shows (Untested): on unless master setting coilcard_untested_label is 'off'."""
        try:
            v = (self._client().get_setting("coilcard_untested_label", "") or "").strip().lower()
            return {"ok": True, "untested": v != "off"}
        except Exception as e:
            return self._fail(e)

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
            import divisions
            domain = self._ad_perm_gate()
            import adperms
            d = self._client().division or {}
            cos = [] if all_divisions else [d.get("name", ""), *divisions.company_names(d)]
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
        import json
        import divisions
        try:
            sc_ = self._scopes()
        except Exception:
            sc_ = {"brands": [], "divisions": []}
        out = [{"label": b["label"], "domain": b["domain"]} for b in sc_["brands"] if b.get("domain")]
        dout = [{"label": d["label"], "company": d["company"]} for d in sc_["divisions"] if d.get("company")]
        have = {d["company"].lower() for d in dout}
        try:                                    # every division in the registry is offered, not just the saved list
            for rd in self._client().registry:
                for co in divisions.company_names(rd):
                    key = co.lower()
                    if key not in have and rd.get("enabled") is not False:
                        dout.append({"label": rd.get("name") or co, "company": co, "division_id": rd.get("id", "")})
                        have.add(key)
        except Exception:
            pass
        return {"ok": True, "locations": out, "divisions": dout,
                "nbgw_company": json.dumps(self._division_companies()),
                "nbgw_label": self._client().division.get("name", "This division")}

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
            import json
            gc = self._client()
            gc.sign_in(interactive=False)
            if not gc._has_dir_read:
                return {"ok": False, "error": "Needs Directory.Read.All (Entra) — ask an admin to grant it, then sign out/in."}
            term = quote('"displayName:' + q.replace('"', "") + '"')
            url = (f"{GRAPH}/users?$search={term}"
                   "&$select=id,displayName,userPrincipalName,department,companyName&$top=50")
            filters = []
            co_values = []
            if isinstance(company, list):
                co_values = company
            else:
                raw_company = (company or "").strip()
                if raw_company.startswith("["):
                    try:
                        parsed = json.loads(raw_company)
                        co_values = parsed if isinstance(parsed, list) else [raw_company]
                    except Exception:
                        co_values = [raw_company]
                elif raw_company:
                    co_values = [raw_company]
            co_values = list(dict.fromkeys(str(c).strip() for c in co_values if str(c).strip()))
            if co_values:
                clause = " or ".join(f"companyName eq '{self._odq(c)}'" for c in co_values)
                filters.append(f"({clause})" if len(co_values) > 1 else clause)
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
        names = self._division_companies()
        if not names:       # never default to another division's company: people queries would leak
            raise RuntimeError("This division has no Entra company name configured.")
        return names[0]

    def _division_companies(self) -> list[str]:
        from divisions import company_names
        return company_names(self._client().division)

    def _company_filter(self, companies) -> str:
        values = [str(c).strip() for c in (companies if isinstance(companies, list) else [companies]) if str(c).strip()]
        values = list(dict.fromkeys(values))
        if not values:
            raise RuntimeError("This division has no Entra company name configured.")
        clause = " or ".join(f"companyName eq '{self._odq(c)}'" for c in values)
        return f"({clause})" if len(values) > 1 else clause
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
        raw_companies = raw.get("companies") if isinstance(raw.get("companies"), list) else None
        if raw_companies is None:
            current = self._division_companies()
            legacy = str(raw.get("company") or "").strip()
            raw_companies = current if not legacy or legacy.casefold() in {c.casefold() for c in current} else [legacy]
        raw_companies = list(dict.fromkeys(str(c).strip() for c in raw_companies if str(c).strip()))
        company = ", ".join(raw_companies)
        depts = raw.get("departments") if isinstance(raw.get("departments"), dict) else {}
        return {"keyword": kw, "threshold": thr, "company": company, "companies": raw_companies, "departments": depts}

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

    def _dept_users(self, gc, dept: str, company: str | list[str]) -> list:
        """Enabled NBGW teammates (Entra companyName == `company`) whose `department`
        equals `dept`. Returns [{id, display, upn}]."""
        filt = (f"department eq '{self._odq(dept)}' and {self._company_filter(company)}"
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
            doc = self._perm_doc()
            company, companies = doc["company"], doc["companies"]
            out = self._users_where(
                gc, f"startsWith(department,'{self._odq(p)}') and {self._company_filter(companies)}"
                    " and accountEnabled eq true", "department")
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
            doc = self._perm_doc()
            company, companies = doc["company"], doc["companies"]
            out = self._users_where(
                gc, f"{self._company_filter(companies)} and accountEnabled eq true",
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
            kw, thr, companies = doc["keyword"], doc["threshold"], doc["companies"]
            users = self._dept_users(gc, name, companies)
            total = len(users)
            if not total:
                return {"ok": False, "error": f"No enabled {doc['company']} teammates found in department “{name}”."}
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
                "company": doc["company"], "groups": groups,
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
            if (user["company"] or "").strip().lower() not in {c.lower() for c in doc["companies"]}:
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
            users = self._dept_users(gc, name, doc["companies"])
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

    # ---- OT device register: division-shared inventory, separate from Intune ----
    _OT_ASSET_FIELDS = {
        "name": 120, "type": 40, "controller_type": 120, "asset_tag": 80, "serial": 100,
        "vendor": 120, "model": 160, "version": 120, "operating_system": 120, "ad_joined": 32,
        "ip_address": 80, "subnet": 80,
        "gateway": 80, "mac_address": 40, "vlan": 40, "switch_port": 100,
        "protocol": 100, "site": 100, "area": 120,
        "line": 120, "panel": 120, "criticality": 24, "status": 24, "documentation_status": 32,
        "job_source": 500, "config_record": 120, "owner": 120, "last_verified": 10,
        "dependencies": 2000, "notes": 2000,
    }
    _OT_ASSET_TYPES = {"Windows PC", "Windows Server", "PLC / Controller", "HMI / Panel",
                       "Network device", "Sensor / Instrument", "Other"}
    _OT_DEFAULT_TYPES = ["Windows PC", "Windows Server", "PLC / Controller", "HMI / Panel",
                         "Network device", "Sensor / Instrument", "Other"]
    _OT_ASSET_STATUSES = {"Active", "Spare", "Maintenance", "Retired"}
    _OT_DOCUMENTATION_STATUSES = {"Documented", "Needs Verification"}
    _OT_AD_STATES = {"Yes", "No", "Unknown", "Needs Verification"}
    _OT_ASSET_CRITICALITIES = {"Low", "Medium", "High", "Critical"}

    _OT_LIST_FIELDS = {"areas": "Area / location", "lines": "Line / process",
                       "panels": "Panel / cabinet", "owners": "Owner / team"}
    _OT_STALE_MONTHS = {3, 6, 12, 24}

    @classmethod
    def _clean_ot_stale_months(cls, value) -> int:
        try:
            months = int(value)
        except (TypeError, ValueError):
            months = 6
        return months if months in cls._OT_STALE_MONTHS else 6

    @classmethod
    def _clean_ot_lists(cls, value, strict=False) -> dict:
        value = value if isinstance(value, dict) else {}
        result = {}
        for key, label in cls._OT_LIST_FIELDS.items():
            raw = value.get(key, [])
            if not isinstance(raw, list):
                if strict:
                    raise ValueError(f"{label} choices must be a list.")
                raw = []
            cleaned, seen = [], set()
            for item in raw:
                if not isinstance(item, str):
                    if strict:
                        raise ValueError(f"{label} choices must be text.")
                    continue
                item = item.strip()
                if len(item) > 100:
                    if strict:
                        raise ValueError(f"{label} choices must be 100 characters or fewer.")
                    item = item[:100]
                marker = item.casefold()
                if item and marker not in seen:
                    cleaned.append(item)
                    seen.add(marker)
                    if len(cleaned) >= 200:
                        break
            result[key] = cleaned
        return result

    def ot_assets_get(self) -> dict:
        try:
            gc = self._client(); gc.sign_in(interactive=False)
            if not (gc.account_upn or "").strip():
                return {"ok": False, "error": "Sign in to view OT device inventory."}
            role = gc.division_role()
            if not role:
                return {"ok": False, "error": "You do not have access to this division."}
            doc = self._hubc().get_named("ot-device-inventory") or {}
            assets = doc.get("assets") if isinstance(doc.get("assets"), list) else []
            types_doc = self._issue_hub().get_named("ot-device-types") or {}
            types = types_doc.get("types") if isinstance(types_doc.get("types"), list) else self._OT_DEFAULT_TYPES
            prefs = self._hubc().get_prefs()
            sites = gc.division.get("sites", []) if isinstance(gc.division, dict) else []
            sites = [s for s in sites if isinstance(s, dict) and s.get("code")]
            return {"ok": True, "assets": assets, "types": types, "can_edit": role in ("super", "admin"),
                    "sites": sites, "lists": self._clean_ot_lists(prefs.get("ot_lists")),
                    "stale_months": self._clean_ot_stale_months(prefs.get("ot_stale_months")),
                    "updated_at": doc.get("updated_at", ""), "updated_by": doc.get("updated_by", "")}
        except Exception as e:
            return self._fail(e)

    @classmethod
    def _clean_ot_asset(cls, value: dict, valid_types: list | None = None) -> dict:
        import ipaddress
        if not isinstance(value, dict):
            raise ValueError("Enter OT device details and try again.")
        raw = dict(value)
        status_value = str(raw.get("status") or "").strip().casefold()
        if status_value in {"pending", "needs verification", "to be captured", "unknown - confirm"}:
            raw["documentation_status"] = "Needs Verification"
            raw["status"] = ""
        elif status_value == "documented":
            raw["documentation_status"] = "Documented"
            raw["status"] = ""
        pending = re.compile(r"^(?:needs? verification|to be captured|unknown(?:\s*[-–—:]\s*confirm)?|not recorded|not captured|not shown(?:\s+on\s+header)?|not listed(?:\s+on\s+ot\s+list)?|yes\s*[-–—:]\s*assumed(?:\s*,?\s*confirm)?|tbd|[-–—])$", re.I)
        asset = {key: str(raw.get(key) or "").strip()[:limit]
                 for key, limit in cls._OT_ASSET_FIELDS.items()}
        for key, text in asset.items():
            if key not in {"notes", "dependencies", "documentation_status", "status"} and text and pending.fullmatch(text):
                asset[key] = "Needs Verification"
        if re.fullmatch(r"no\s*\(embedded\)", asset["ad_joined"], re.I):
            asset["ad_joined"] = "No"
        elif re.fullmatch(r"yes\s*[-–—]\s*nucorsteel\.local", asset["ad_joined"], re.I):
            asset["ad_joined"] = "Yes"
        if not asset["name"]:
            raise ValueError("Device name is required.")
        if asset["type"] not in set(valid_types or cls._OT_DEFAULT_TYPES):
            raise ValueError("Choose a valid OT device type.")
        if asset["status"] and asset["status"] not in cls._OT_ASSET_STATUSES:
            raise ValueError("Choose a valid status.")
        if asset["documentation_status"] and asset["documentation_status"] not in cls._OT_DOCUMENTATION_STATUSES:
            raise ValueError("Choose Documented or Needs Verification for documentation status.")
        if asset["ad_joined"] and asset["ad_joined"] not in cls._OT_AD_STATES:
            raise ValueError("Choose Yes, No, Unknown, or Needs Verification for AD-joined.")
        if asset["criticality"] and asset["criticality"] not in cls._OT_ASSET_CRITICALITIES:
            raise ValueError("Choose a valid criticality.")
        for key in ("ip_address", "gateway"):
            if asset[key] and not pending.fullmatch(asset[key]):
                try:
                    ipaddress.ip_address(asset[key])
                except ValueError as e:
                    raise ValueError(f"{key.replace('_', ' ').title()} must be a valid IP address.") from e
        if asset["subnet"] and not pending.fullmatch(asset["subnet"]):
            try:
                ipaddress.ip_network("0.0.0.0/" + asset["subnet"], strict=False)
            except ValueError:
                try:
                    ipaddress.ip_network("::/" + asset["subnet"], strict=False)
                except ValueError as e:
                    raise ValueError("Subnet must be a prefix length (such as 24) or subnet mask (such as 255.255.255.0).") from e
        if asset["mac_address"] and not pending.fullmatch(asset["mac_address"]):
            compact = re.sub(r"[^0-9a-f]", "", asset["mac_address"].lower())
            if len(compact) != 12 or not re.fullmatch(r"[0-9a-f]{12}", compact):
                raise ValueError("MAC address must contain 12 hexadecimal digits.")
            asset["mac_address"] = ":".join(compact[i:i + 2] for i in range(0, 12, 2)).upper()
        if asset["last_verified"] and not pending.fullmatch(asset["last_verified"]):
            try:
                date.fromisoformat(asset["last_verified"])
            except ValueError as e:
                raise ValueError("Last verified must be a valid date.") from e
        asset["status"] = asset["status"] or "Active"
        asset["documentation_status"] = asset["documentation_status"] or "Needs Verification"
        asset["criticality"] = asset["criticality"] or "Medium"
        return asset

    def _ot_asset_mutate(self, asset_id: str, asset: dict | None = None) -> dict:
        gc = self._client(); gc.require_division_admin()
        hub = self._hubc()
        doc_name = "ot-device-inventory"
        for attempt in range(3):
            doc = hub.get_named(doc_name) or {}
            rows = [row for row in (doc.get("assets") or []) if isinstance(row, dict)]
            found = next((row for row in rows if str(row.get("id") or "") == asset_id), None)
            if asset is None:
                if not found:
                    return {"ok": False, "error": "OT device was already removed. Refresh the list."}
                rows = [row for row in rows if str(row.get("id") or "") != asset_id]
                action = "removed"
                label = found.get("name") or asset_id
            else:
                now = datetime.now().astimezone().isoformat()
                saved = {**asset, "id": asset_id,
                         "created_at": (found or {}).get("created_at") or now,
                         "created_by": (found or {}).get("created_by") or self._actor() or gc.account_upn,
                         "updated_at": now, "updated_by": self._actor() or gc.account_upn}
                rows = [row for row in rows if str(row.get("id") or "") != asset_id]
                if len(rows) >= 3000:
                    return {"ok": False, "error": "OT inventory limit reached (3,000 devices)."}
                rows.append(saved)
                action = "updated" if found else "added"
                label = saved["name"]
            rows.sort(key=lambda row: str(row.get("name") or "").casefold())
            new_doc = {**{k: v for k, v in doc.items() if k not in ("assets", "updated_at", "updated_by")},
                       "assets": rows, "updated_at": datetime.now().astimezone().isoformat(),
                       "updated_by": self._actor() or gc.account_upn}
            try:
                hub.put_named(doc_name, new_doc)
                try:
                    hub._change("OT device", f"{action}: {label}", actor=self._actor() or gc.account_upn)
                except Exception:
                    pass
                return {"ok": True, "asset": saved if asset is not None else None, "assets": rows}
            except Exception as e:
                if e.__class__.__name__ != "HubConflict" or attempt == 2:
                    raise
                store = getattr(hub, "_store", None)
                if store:
                    store._cache.pop("ot-device-inventory", None)
                    store._rev.pop(("ot-device-inventory", "main"), None)
        return {"ok": False, "error": "OT inventory changed elsewhere. Refresh and try again."}

    def ot_asset_save(self, value: dict) -> dict:
        try:
            types_doc = self._issue_hub().get_named("ot-device-types") or {}
            valid_types = list(types_doc.get("types") or self._OT_DEFAULT_TYPES)
            asset_id = str((value or {}).get("id") or "").strip()[:80]
            if asset_id:
                existing = next((a for a in (self._hubc().get_named("ot-device-inventory") or {}).get("assets", [])
                                 if isinstance(a, dict) and str(a.get("id") or "") == asset_id), None)
                if existing and existing.get("type") and existing["type"] not in valid_types: valid_types.append(existing["type"])
            asset = self._clean_ot_asset(value, valid_types)
            asset_id = asset_id or __import__("uuid").uuid4().hex
            return self._ot_asset_mutate(asset_id, asset)
        except Exception as e:
            return self._fail(e)

    def ot_asset_delete(self, asset_id: str) -> dict:
        try:
            key = str(asset_id or "").strip()[:80]
            if not key:
                return {"ok": False, "error": "Select an OT device to remove."}
            return self._ot_asset_mutate(key, None)
        except Exception as e:
            return self._fail(e)

    def ot_asset_verify(self, asset_id: str) -> dict:
        try:
            gc = self._client(); gc.require_division_admin()
            key = str(asset_id or "").strip()[:80]
            if not key:
                return {"ok": False, "error": "Select an OT device to verify."}
            hub = self._hubc(); name = "ot-device-inventory"
            for attempt in range(3):
                doc = hub.get_named(name) or {}
                rows = [row for row in (doc.get("assets") or []) if isinstance(row, dict)]
                asset = next((row for row in rows if str(row.get("id") or "") == key), None)
                if not asset:
                    return {"ok": False, "error": "OT device was removed. Refresh the list."}
                now = datetime.now().astimezone().isoformat()
                updated = {**asset, "last_verified": date.today().isoformat(), "updated_at": now,
                           "updated_by": self._actor() or gc.account_upn}
                rows = [updated if str(row.get("id") or "") == key else row for row in rows]
                new_doc = {**{k: v for k, v in doc.items() if k not in ("assets", "updated_at", "updated_by")},
                           "assets": rows, "updated_at": now, "updated_by": self._actor() or gc.account_upn}
                try:
                    hub.put_named(name, new_doc)
                    try: hub._change("OT device", f"verified: {updated.get('name') or key}", actor=self._actor() or gc.account_upn)
                    except Exception: pass
                    return {"ok": True, "asset": updated, "assets": rows}
                except Exception as e:
                    if e.__class__.__name__ != "HubConflict" or attempt == 2:
                        raise
                    store = getattr(hub, "_store", None)
                    if store:
                        store._cache.pop(name, None); store._rev.pop((name, "main"), None)
            return {"ok": False, "error": "OT inventory changed elsewhere. Refresh and try again."}
        except Exception as e:
            return self._fail(e)

    def ot_device_types_get(self) -> dict:
        try:
            gc = self._client(); gc.sign_in(interactive=False)
            if not gc.is_super_admin(): return {"ok": False, "error": "Super admins only."}
            doc = self._issue_hub().get_named("ot-device-types") or {}
            types = doc.get("types") if isinstance(doc.get("types"), list) else self._OT_DEFAULT_TYPES
            return {"ok": True, "types": types}
        except Exception as e:
            return self._fail(e)

    def ot_device_types_save(self, types: list) -> dict:
        try:
            gc = self._client(); gc.sign_in(interactive=False)
            if not gc.is_super_admin(): return {"ok": False, "error": "Super admins only."}
            cleaned, seen = [], set()
            for value in (types or []):
                label = str(value or "").strip()[:40]
                key = label.casefold()
                if label and key not in seen: cleaned.append(label); seen.add(key)
            if not cleaned: return {"ok": False, "error": "Keep at least one OT device type."}
            if len(cleaned) > 40: return {"ok": False, "error": "Maximum 40 device types."}
            self._issue_hub().put_named("ot-device-types", {"types": cleaned, "updated_at": datetime.now().astimezone().isoformat(), "updated_by": self._actor() or gc.account_upn})
            return {"ok": True, "types": cleaned}
        except Exception as e:
            return self._fail(e)

    def ot_xlsx_read(self, content_base64: str, sheet_name: str = "") -> dict:
        """Read one worksheet from a small XLSX workbook using only stdlib modules."""
        import base64
        import io
        import posixpath
        import zipfile
        import xml.etree.ElementTree as ET
        try:
            if not isinstance(content_base64, str) or len(content_base64) > 7 * 1024 * 1024:
                return {"ok": False, "error": "Excel workbook must be under 5 MB."}
            raw = base64.b64decode(content_base64, validate=True)
            if len(raw) > 5 * 1024 * 1024:
                return {"ok": False, "error": "Excel workbook must be under 5 MB."}
            with zipfile.ZipFile(io.BytesIO(raw)) as workbook:
                if sum(item.file_size for item in workbook.infolist()) > 50 * 1024 * 1024:
                    return {"ok": False, "error": "Expanded workbook is too large to import safely."}
                names = set(workbook.namelist())
                if "xl/workbook.xml" not in names or "xl/_rels/workbook.xml.rels" not in names:
                    return {"ok": False, "error": "This file is not a valid Excel workbook."}
                wb_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
                doc_rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                pkg_rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
                workbook_root = ET.fromstring(workbook.read("xl/workbook.xml"))
                rel_root = ET.fromstring(workbook.read("xl/_rels/workbook.xml.rels"))
                relations = {item.attrib.get("Id"): item.attrib.get("Target", "")
                             for item in rel_root.findall(f"{{{pkg_rel_ns}}}Relationship")}
                sheets = []
                for item in workbook_root.findall(f".//{{{wb_ns}}}sheet"):
                    name = item.attrib.get("name", "")
                    target = relations.get(item.attrib.get(f"{{{doc_rel_ns}}}id"), "")
                    if not name or not target:
                        continue
                    path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
                    if path in names:
                        sheets.append((name, path))
                if not sheets:
                    return {"ok": False, "error": "No worksheets found in this workbook."}
                selected = next((pair for pair in sheets if pair[0] == sheet_name), sheets[0])
                shared = []
                if "xl/sharedStrings.xml" in names:
                    strings_root = ET.fromstring(workbook.read("xl/sharedStrings.xml"))
                    shared = ["".join(node.text or "" for node in item.findall(f".//{{{wb_ns}}}t"))
                              for item in strings_root.findall(f"{{{wb_ns}}}si")]
                sheet_root = ET.fromstring(workbook.read(selected[1]))
                sparse_rows = []
                for row_node in sheet_root.findall(f".//{{{wb_ns}}}sheetData/{{{wb_ns}}}row"):
                    values = {}
                    for cell in row_node.findall(f"{{{wb_ns}}}c"):
                        ref = cell.attrib.get("r", "")
                        match = re.match(r"([A-Z]+)", ref.upper())
                        if not match:
                            continue
                        col = 0
                        for char in match.group(1):
                            col = col * 26 + ord(char) - 64
                        col -= 1
                        if col < 0 or col >= 300:
                            continue
                        kind = cell.attrib.get("t", "")
                        if kind == "inlineStr":
                            value = "".join(node.text or "" for node in cell.findall(f".//{{{wb_ns}}}t"))
                        else:
                            value_node = cell.find(f"{{{wb_ns}}}v")
                            value = value_node.text or "" if value_node is not None else ""
                            if kind == "s" and value:
                                try:
                                    value = shared[int(value)]
                                except (ValueError, IndexError):
                                    value = ""
                            elif kind == "b":
                                value = "TRUE" if value == "1" else "FALSE"
                        values[col] = str(value)
                    sparse_rows.append(values)
                    if len(sparse_rows) > 10002:
                        return {"ok": False, "error": "Worksheet is too large to import in one batch."}
                width = max((max(row.keys(), default=-1) for row in sparse_rows), default=-1) + 1
                rows = [[row.get(col, "") for col in range(width)] for row in sparse_rows]
                rows = [row for row in rows if any(str(value).strip() for value in row)]
                if len(rows) < 2:
                    return {"ok": False, "error": "Selected worksheet needs a header row and at least one data row."}
                if len(rows) > 1001:
                    return {"ok": False, "error": "Worksheet has more than 1,000 data rows. Split it into smaller imports."}
                return {"ok": True, "sheets": [name for name, _ in sheets], "sheet": selected[0], "rows": rows}
        except (ValueError, zipfile.BadZipFile, ET.ParseError) as e:
            return {"ok": False, "error": f"Could not read Excel workbook: {str(e)[:180]}"}
        except Exception as e:
            return self._fail(e)

    def ot_assets_import(self, values: list) -> dict:
        try:
            gc = self._client(); gc.require_division_admin()
            if not isinstance(values, list) or not values: return {"ok": False, "error": "Choose CSV rows to import."}
            if len(values) > 1000: return {"ok": False, "error": "Import limit is 1,000 rows at a time."}
            hub = self._hubc(); name = "ot-device-inventory"; doc = hub.get_named(name) or {}
            rows = [x for x in (doc.get("assets") or []) if isinstance(x, dict)]
            type_doc = self._issue_hub().get_named("ot-device-types") or {}
            types = type_doc.get("types") or self._OT_DEFAULT_TYPES
            now = datetime.now().astimezone().isoformat(); added = updated = skipped = errors = 0; row_errors = []
            imported_choice_values = {"areas": set(), "lines": set(), "panels": set(), "owners": set()}
            asset_choice_fields = {"area": "areas", "line": "lines", "panel": "panels", "owner": "owners"}
            def import_identifier(raw):
                key = str(raw or "").strip().casefold()
                return "" if key in {"needs verification", "to be captured", "unknown", "unknown - confirm", "not recorded", "not captured", "not shown on header", "tbd", "-"} else key
            for index, value in enumerate(values, 1):
                try:
                    asset = self._clean_ot_asset(value, types)
                    serial = import_identifier(asset.get("serial")); tag = import_identifier(asset.get("asset_tag"))
                    if not serial: asset["serial"] = ""
                    if not tag: asset["asset_tag"] = ""
                    old = next((x for x in rows if (value.get("id") and x.get("id") == value["id"]) or
                                (serial and import_identifier(x.get("serial")) == serial) or
                                (tag and import_identifier(x.get("asset_tag")) == tag)), None)
                    if old is None and not serial and not tag and asset.get("name"):
                        # A prior import may have stored the placeholder "Needs Verification" in an
                        # identifier field. Reuse that record only when its name match is unambiguous.
                        candidates = [x for x in rows if str(x.get("name") or "").strip().casefold() == asset["name"].casefold()
                                      and not import_identifier(x.get("serial")) and not import_identifier(x.get("asset_tag"))]
                        if len(candidates) == 1: old = candidates[0]
                    if old:
                        asset = {**old, **{k: v for k, v in asset.items() if v}, "id": old["id"],
                                 "created_at": old.get("created_at") or now, "created_by": old.get("created_by") or gc.account_upn,
                                 "updated_at": now, "updated_by": self._actor() or gc.account_upn}
                        for key in ("serial", "asset_tag"):
                            if not import_identifier(old.get(key)) and not import_identifier(asset.get(key)):
                                asset[key] = ""
                        rows = [x for x in rows if x.get("id") != old.get("id")]; updated += 1
                    else:
                        if len(rows) >= 3000: skipped += 1; continue
                        asset.update({"id": __import__("uuid").uuid4().hex, "created_at": now, "created_by": self._actor() or gc.account_upn,
                                      "updated_at": now, "updated_by": self._actor() or gc.account_upn}); added += 1
                    for asset_field, list_field in asset_choice_fields.items():
                        choice = str(asset.get(asset_field) or "").strip()
                        if choice and choice.casefold() != "needs verification":
                            imported_choice_values[list_field].add(choice[:100])
                    rows.append(asset)
                except Exception as e:
                    errors += 1; skipped += 1
                    if len(row_errors) < 10: row_errors.append(f"Row {index + 1}: {str(e)[:160]}")
            rows.sort(key=lambda row: str(row.get("name") or "").casefold())
            new_doc = {**{k: v for k, v in doc.items() if k not in ("assets", "updated_at", "updated_by")}, "assets": rows,
                       "updated_at": now, "updated_by": self._actor() or gc.account_upn}
            hub.put_named(name, new_doc)
            prefs = hub.get_prefs()
            lists = self._clean_ot_lists(prefs.get("ot_lists"))
            added_choices = 0
            for list_field, incoming in imported_choice_values.items():
                existing = {choice.casefold() for choice in lists[list_field]}
                for choice in sorted(incoming, key=str.casefold):
                    marker = choice.casefold()
                    if marker in existing or len(lists[list_field]) >= 200:
                        continue
                    lists[list_field].append(choice)
                    existing.add(marker)
                    added_choices += 1
            choice_error = ""
            if added_choices:
                prefs["ot_lists"] = lists
                try:
                    hub.save_prefs(prefs, {"action": "import", "target": "OT division choices",
                                           "detail": f"Added {added_choices} choices from OT device import"})
                    gc.__dict__.pop("_prefs_cache", None)
                except Exception as e:
                    choice_error = str(e)[:180]
            return {"ok": True, "assets": rows, "added": added, "updated": updated, "skipped": skipped,
                    "errors": errors, "row_errors": row_errors, "lists": lists,
                    "added_choices": added_choices if not choice_error else 0, "choice_error": choice_error}
        except Exception as e:
            return self._fail(e)

    def ot_assets_send_reminders(self) -> dict:
        try:
            import notify
            gc = self._client(); gc.require_division_admin()
            hub = self._hubc(); doc = hub.get_named("ot-device-inventory") or {}
            assets = [a for a in (doc.get("assets") or []) if isinstance(a, dict)]
            stale, missing = [], []
            months = self._clean_ot_stale_months((hub.get_prefs() or {}).get("ot_stale_months"))
            today = date.today()
            target_month = today.month - months
            target_year = today.year + (target_month - 1) // 12
            target_month = (target_month - 1) % 12 + 1
            import calendar
            cutoff = date(target_year, target_month, min(today.day, calendar.monthrange(target_year, target_month)[1]))
            for a in assets:
                try:
                    verified = str(a.get("last_verified") or "").strip()
                    reviewed = date.fromisoformat(verified) if verified else datetime.fromisoformat(str(a.get("updated_at") or a.get("created_at") or "").replace("Z", "+00:00")).date()
                except Exception:
                    reviewed = date.min
                if reviewed < cutoff: stale.append(a)
                if any(not str(a.get(k) or "").strip() for k in ("vendor", "model", "site", "version", "last_verified")): missing.append(a)
            if not stale and not missing: return {"ok": True, "message": "All OT records are current and complete. No reminder sent."}
            prefs = hub.get_prefs()
            recipients = notify.division_recipients(notify.division_subscribers_doc(prefs.get("issue_subscribers")), "ot")
            if not recipients: return {"ok": False, "error": "No recipients enabled. Add people under Settings > General > Division email notifications and enable OT asset review reminders."}
            lines = [f"{len(assets)} OT assets reviewed.", f"{len(stale)} have not been verified in {months} months or more.", f"{len(missing)} are missing key information (vendor, model, site, version, or verification date).", "", "Open NBG Hub > OT Devices and filter for stale or missing information."]
            for a in (stale + [x for x in missing if x not in stale])[:60]:
                gaps = [k.replace("_", " ") for k in ("vendor", "model", "site", "version", "last_verified") if not str(a.get(k) or "").strip()]
                lines.append(f"• {a.get('name') or 'Unnamed device'} — {'stale' if a in stale else 'updated recently'}" + (f"; missing {', '.join(gaps)}" if gaps else ""))
            division = (gc.division or {}).get("name") or (gc.division or {}).get("id") or "Division"
            subject, text, html = notify.render_notice(division, "OT asset information needs review", "\n".join(lines), "ot")
            result = notify.deliver(gc, recipients, subject, text, html, "ot", {"title": "OT asset information needs review", "division": {"name": division}})
            if not result.get("sent"): return {"ok": False, "error": result.get("error") or "No reminder was sent."}
            return {"ok": True, "message": f"Reminder sent to {result['sent']} recipient(s) via {result.get('via')}. {len(stale)} stale and {len(missing)} incomplete records."}
        except Exception as e:
            return self._fail(e)

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

    # ---- back-fill and import of deploy / manufacture dates ----
    @staticmethod
    def _iso_date(v, label):
        import datetime
        v = str(v or "").strip()
        if not v:
            return ""
        try:
            d = datetime.date.fromisoformat(v)
        except ValueError:
            raise ValueError(f"{label} '{v}' is not a date like 2026-09-30.")
        if d > datetime.date.today() or d.year < 1990:
            raise ValueError(f"{label} '{v}' is outside the allowed range.")
        return v

    def deploy_backfill(self, commit: bool = False) -> dict:
        """Fill BLANK deploy dates of In Use devices from the Intune enrollment date (kept in the OS Install Date column).
        commit=False only counts. Existing dates are never overwritten. One log entry per run. Admins only."""
        try:
            import datetime
            gc = self._client()
            if gc.division_role() not in ("super", "admin"):
                return {"ok": False, "error": "Only division admins can fill dates in bulk."}
            items = gc._items_raw("in_use")
            if items and not gc._internal_for("in_use", "deploy_date"):
                return {"ok": False, "error": "The In Use list has no 'Deploy Date' column yet."}
            hub_dates = (self._hubc().get_named("device-dates") or {}).get("dates") or {}
            today = datetime.date.today()
            todo, has, no_src = [], 0, 0
            for it in items:
                cur = gc._row(it["fields"], "in_use", in_use=True)
                serial = (cur.get("serial") or "").strip()
                if not serial:
                    continue
                if cur.get("deploy_date") or (hub_dates.get(serial.lower()) or {}).get("deploy"):
                    has += 1
                    continue
                src = (cur.get("os_install") or "")[:10]
                try:
                    d = datetime.date.fromisoformat(src)
                except ValueError:
                    no_src += 1
                    continue
                if d > today or d.year < 1990:
                    no_src += 1
                    continue
                todo.append((it["id"], serial, src))
            out = {"ok": True, "candidates": len(todo), "already": has, "no_source": no_src, "written": 0,
                   "sample": [{"serial": s, "date": d} for _, s, d in todo[:5]], "errors": []}
            if commit and todo:
                streak = 0
                for iid, serial, d in todo:
                    try:
                        gc.update_item("in_use", iid, {"deploy_date": d})
                        out["written"] += 1
                        streak = 0
                    except Exception as e:
                        out["errors"].append(f"{serial}: {e}")
                        streak += 1
                        if streak >= 5:
                            out["errors"].append("Stopped after 5 failures in a row.")
                            break
                gc.add_log("Device dates", "", "", actor=gc.account_name or "",
                           details=f"Deploy dates filled from Intune enrollment date on {out['written']} In Use device(s)")
            return out
        except Exception as e:
            return self._fail(e)

    def device_dates_import(self, rows: list, commit: bool = False) -> dict:
        """Import deploy / manufacture dates for many serials: rows = [{serial, deploy?, mfg?}] with ISO dates.
        commit=False only reports matches. A blank date cell leaves that date alone. One change entry per run."""
        try:
            gc = self._client()
            if gc.division_role() not in ("super", "admin"):
                return {"ok": False, "error": "Only division admins can import dates."}
            rows = list(rows or [])[:2000]
            known = set()
            for key in ("in_use", "new_stock"):
                known.update((it.get("fields", {}).get("Title") or "").strip().lower() for it in gc._items_raw(key))
            clean, unmatched, bad = {}, [], []
            for r in rows:
                s = str((r or {}).get("serial") or "").strip()
                if not s:
                    continue
                try:
                    dep = self._iso_date((r or {}).get("deploy"), "Deploy date")
                    mf = self._iso_date((r or {}).get("mfg"), "Manufacture date")
                except ValueError as ve:
                    bad.append(f"{s}: {ve}")
                    continue
                if not dep and not mf:
                    continue
                if s.lower() not in known:
                    unmatched.append(s)
                    continue
                cur = clean.setdefault(s.lower(), {"serial": s})
                if dep:
                    cur["deploy"] = dep
                if mf:
                    cur["mfg"] = mf
            out = {"ok": True, "matched": len(clean), "unmatched": unmatched[:200], "unmatched_count": len(unmatched),
                   "invalid": bad[:50], "invalid_count": len(bad), "written": 0, "columns": 0}
            if commit and clean:
                h = self._hubc()
                for attempt in range(3):
                    try:
                        doc = h.get_named("device-dates") or {}
                        dates = dict(doc.get("dates") or {})
                        for k, v in clean.items():
                            cur = dict(dates.get(k) or {})
                            if v.get("deploy"):
                                cur["deploy"] = v["deploy"]
                            if v.get("mfg"):
                                cur["mfg"] = v["mfg"]
                            dates[k] = cur
                        h.put_named("device-dates", {"dates": dates})
                        break
                    except Exception as ce:
                        if ce.__class__.__name__ != "HubConflict" or attempt == 2:
                            raise
                try:
                    out["columns"] = gc.set_row_dates_bulk({k: (v.get("deploy"), v.get("mfg")) for k, v in clean.items()})
                except Exception:
                    pass
                out["written"] = len(clean)
                try:
                    h._change("Device dates", f"{self._actor() or 'NBG Hub'}: imported dates for {len(clean)} device(s)")
                except Exception:
                    pass
            return out
        except Exception as e:
            return self._fail(e)

    def health_get(self) -> dict:
        """System health for admins: last sync, SharePoint columns check, counts and how complete the date data is."""
        try:
            import synclock
            import schema
            import version
            gc = self._client()
            if gc.division_role() not in ("super", "admin"):
                return {"ok": False, "error": "Health is for admins."}
            out = {"ok": True, "version": getattr(version, "APP_VERSION", ""), "account": gc.account_upn or "",
                   "mode": getattr(gc, "data_mode", ""), "division": (gc.division or {}).get("name", "")}
            try:
                out["sync"] = synclock.status(self._hubc())
            except Exception as e:
                out["sync"] = {"error": str(e)}
            try:                                               # same check as tools\check_central.py, plus the optional date columns
                found = schema.problems(gc)
                notes = [f"{n}: {x}" for n, xs in found.items() for x in xs]
                for key in ("in_use", "new_stock"):
                    for logical, label in (("deploy_date", "Deploy Date"), ("mfg_date", "Mfg Date")):
                        if not gc._internal_for(key, logical):
                            notes.append(f"{gc.cfg['lists'].get(key, key)}: optional column '{label}' is missing")
                out["columns"] = {"ok": not notes, "notes": notes}
            except Exception as e:
                out["columns"] = {"ok": False, "notes": [f"Could not check: {e}"]}
            try:
                use, stock = gc.get_in_use(), gc.get_new_stock()
                dev = use + stock
                out["counts"] = {"in_use": len(use), "stock": len(stock),
                                 "deploy_dates": sum(1 for r in use if r.get("deploy_date")),
                                 "mfg_dates": sum(1 for r in dev if r.get("mfg_date")),
                                 "total": len(dev)}
            except Exception as e:
                out["counts"] = {"error": str(e)}
            return out
        except Exception as e:
            return self._fail(e)

    def update_specs_bulk(self, items: list) -> dict:
        """Set specs on several devices at once (same model, 'Save & next'). items = [{serial, fields}]. One audit entry, one requeue."""
        try:
            import re as _re
            import sync
            gc = self._client()
            todo = []
            for it in (items or [])[:200]:
                serial = str((it or {}).get("serial") or "").strip()
                upd = {}
                for k in ("cpu", "ram", "storage", "warranty"):
                    v = (it.get("fields") or {}).get(k)
                    if v is None:
                        continue
                    v = " ".join(str(v).split())
                    if len(v) > 120:
                        return {"ok": False, "error": f"{k.upper()} is too long."}
                    if k == "warranty" and v and not _re.match(r"^\d{4}-\d{2}-\d{2}$", v):
                        return {"ok": False, "error": "Warranty must be a date like 2027-05-31."}
                    upd[k] = v
                if serial and upd:
                    todo.append((serial, upd))
            done, missing = 0, []
            for serial, upd in todo:
                key, item = "in_use", gc.find_by_serial("in_use", serial)
                if not item:
                    key, item = "new_stock", gc.find_by_serial("new_stock", serial)
                if not item:
                    missing.append(serial)
                    continue
                gc.update_item(key, item["id"], upd)
                done += 1
            if done:
                gc.add_log("Specs edited", "", "", actor=gc.account_name or "", details=f"Bulk: {done} device(s)")
            queued = sync.queue_upgrades(gc) if done else 0
            return {"ok": True, "updated": done, "not_found": missing, "queued_upgrades": queued}
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
            try:
                owner_classifications = (self._hubc().get_named("device-classifications") or {}).get("classifications") or {}
            except Exception:
                owner_classifications = {}
            is_shared_machine = lambda r: owner_classifications.get((r.get("serial") or "").strip().lower()) == "shared"
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
            try:
                checked_out_u = {str(serial).strip().upper() for serial, item in
                                 (self._hubc().get_named("device-lifecycle-index") or {}).get("devices", {}).items()
                                 if item.get("status") == "checked_out"}
            except Exception:
                checked_out_u = set()
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
            held_u = reserved_serials_u | hot_serials_u | checked_out_u
            if held_u:
                new_stock = [r for r in new_stock_full
                             if (r.get("serial") or "").strip().upper() not in held_u]
            # in-use devices whose primary user has NOT registered MFA (drill-down).
            # Reads the persisted MFA cell (filled fill-when-blank by enrich_in_use);
            # "" (not yet resolved) is not counted as "no MFA".
            no_mfa = [{"serial": r.get("serial", ""), "device_name": r.get("device_name", ""),
                       "model": r.get("model", ""), "user": r.get("user", ""), "source": "In Use"}
                      for r in in_use if r.get("mfa") == "No" and (r.get("user") or "").strip()]
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
                site = (r.get("site_tag") or "").strip().upper()
                skey = site if site in div_sites else "Other"
                raw_depts = dept_map.get((r.get("model") or "").strip()) or []
                depts = raw_depts if isinstance(raw_depts, list) else [raw_depts]
                for dep in [str(d).strip() for d in depts if str(d).strip()] or ["Unassigned"]:
                    stock_by_dept[dep] = stock_by_dept.get(dep, 0) + 1
                    d = stock_by_dept_site.setdefault(dep, {})
                    d[skey] = d.get(skey, 0) + 1
            # devices whose primary user is NOT at an NBGW site (LTR/BRI): their
            # resolved "site" is an office location elsewhere. Surfaced on the dashboard
            # with a drill-down.
            nbgw_sites = div_sites
            not_nbgw, by_office = [], {}
            for r in in_use:
                site = (r.get("site_tag") or "").strip()
                if (r.get("user") or "").strip() and site and site.upper() not in nbgw_sites:
                    not_nbgw.append({"serial": r.get("serial", ""), "model": r.get("model", ""),
                                     "user": r.get("user", ""), "office": site})
                    by_office[site] = by_office.get(site, 0) + 1
            # Blank primary users split into action-needed owners and intentional shared machines.
            # Both remain in the inventory totals.
            no_upn = [{"serial": r.get("serial", ""), "device_name": r.get("device_name", ""),
                       "model": r.get("model", ""), "site": r.get("site_tag", ""), "source": "In Use",
                       "classification": "Shared machine" if is_shared_machine(r) else "Needs owner"}
                      for r in in_use if not (r.get("user") or "").strip()]
            needs_owner = [r for r in no_upn if r["classification"] == "Needs owner"]
            shared_machines = [r for r in no_upn if r["classification"] == "Shared machine"]
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
                "needs_owner_count": len(needs_owner),
                "needs_owner": needs_owner,
                "shared_machine_count": len(shared_machines),
                "shared_machines": shared_machines,
                # Keep factual no-UPN fields for older UI builds; new owner-gap UI uses fields above.
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


for _n in ("run_sync", "enrich_inventory", "master_sync", "populate_mfa", "boneyard_sweep", "sync_all_divisions", "software_refresh", "mfa_people_refresh", "windows_updates_refresh", "sharepoint_permissions_scan", "sharepoint_permissions_search_sites"):
    setattr(Api, _n, _long_op(getattr(Api, _n)))


def _arg(a, k, i, name, default=None):
    return a[i] if len(a) > i else k.get(name, default)


# Admin and settings changes that were not recorded anywhere. Each entry: (what happened, "platform" | "division", detail text).
# Details never include secret values: only names / counts.
_AUDIT = {
    "save_super_admins": ("Super admins changed", "platform", lambda a, k, r: f"{len(_arg(a, k, 0, 'admins') or [])} super admin(s) now"),
    "save_division": ("Division saved", "platform", lambda a, k, r: str((_arg(a, k, 0, "division") or {}).get("id") or (_arg(a, k, 0, "division") or {}).get("name") or "")),
    "set_master_setting": ("Master setting changed", "platform", lambda a, k, r: f"{_arg(a, k, 0, 'key')} (value not logged)"),
    "save_issue_subscribers": ("Issue notification list changed", "platform", lambda a, k, r: f"{len(_arg(a, k, 0, 'subscribers') or [])} subscriber(s)"),
    "save_search_scopes": ("People-search scopes changed", "platform", lambda a, k, r: ""),
    "save_role_access": ("Role access changed", "platform", lambda a, k, r: ""),
    "save_own_division": ("Division settings changed", "division", lambda a, k, r: "fields: " + ", ".join(sorted((_arg(a, k, 0, "data") or {}).keys()))),
    "set_data_mode": ("Data mode changed", "platform", lambda a, k, r: f"to {_arg(a, k, 0, 'mode')}"),
    "hub_save_template_config": ("Template checklists changed", "platform", lambda a, k, r: ""),
    "hub_save_config": ("Checklists changed", "division", lambda a, k, r: ""),
    "hub_save_departments": ("Model departments changed", "division", lambda a, k, r: ""),
    "issue_create": ("Issue filed", "platform", lambda a, k, r: f"{_arg(a, k, 0, 'kind')}: {str(_arg(a, k, 1, 'title') or '')[:80]}"),
    "issue_update": ("Issue changed", "platform", lambda a, k, r: f"{_arg(a, k, 0, 'issue_id')}: " + ", ".join(f"{x}={str(v)[:30]}" for x, v in (_arg(a, k, 1, 'fields') or {}).items() if x in ("status", "assignee", "type"))),
    "issue_delete": ("Issue deleted", "platform", lambda a, k, r: str(_arg(a, k, 0, "issue_id"))),
    "issues_import_legacy": ("Issues imported", "platform", lambda a, k, r: ""),
    "pull_prod_snapshot": ("Snapshot copied to Local mode", "platform", lambda a, k, r: ""),
    "sign_in": ("Signed in", "platform", lambda a, k, r: str(r.get("account") or "")),
}


def _audited(fn, target, scope, describe):
    import functools

    @functools.wraps(fn)
    def wrapper(self, *a, **k):
        res = fn(self, *a, **k)
        try:
            if isinstance(res, dict) and res.get("ok"):
                self._audit(target, str(describe(a, k, res) or ""), scope)
        except Exception:
            pass
        return res
    return wrapper


for _n, (_t, _s, _d) in _AUDIT.items():
    setattr(Api, _n, _audited(getattr(Api, _n), _t, _s, _d))


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
    api._window = window

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
