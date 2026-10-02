#!/usr/bin/env python3
r"""
NBGW Endpoint Hub - file-based side of the unified hub.

The "setup runbooks" half of the app stores everything as plain JSON/HTML files
under the OneDrive-synced Systems SharePoint library, so the whole team shares one
live picture with no auth. This module is the Python port of the old C# server's
file logic; the folder layout is IDENTICAL, so data written by the standalone
Endpoint Hub .exe is read here unchanged:

    <shared>\
        <Computer|User> Setup - <name> - <id>.html    human-readable records
        _EndpointHub\
            nbgw-endpoint-hub-config.json              shared checklist config
            setups\   <id>.json                        one per setup (resumable, %-complete)
            changes\  <stamp>.json                     one per program change
            feedback\ <id>.json                        one per bug / feature request

One file per item so concurrent saves on the synced folder never clobber.
No network, no auth - OneDrive handles the SharePoint delivery.
"""
from __future__ import annotations

import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d_%H%M%S")


def _user() -> str:
    return os.environ.get("USERNAME") or os.environ.get("USER") or ""


def _machine() -> str:
    return os.environ.get("COMPUTERNAME") or ""


def _app_dir() -> str:
    """Folder the app runs from — the .exe's folder when frozen (this is the
    OneDrive-synced deployment folder), else the source dir."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _config_logs_folder() -> str | None:
    """Optional override: 'logs_folder' in config.json next to the app/exe."""
    try:
        cfg = os.path.join(_app_dir(), "config.json")
        if os.path.exists(cfg):
            with open(cfg, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
            v = (data.get("logs_folder") or "").strip()
            return v or None
    except Exception:
        pass
    return None


class Hub:
    """The shared-folder Endpoint Hub store. All methods are cheap file IO."""

    def __init__(self, logs_folder: str | None = None, division: dict | None = None, store=None):
        # Resolve the shared data root. A configured `logs_folder` may use
        # environment variables (e.g. %ONEDRIVE%) and, crucially, may be RELATIVE —
        # in which case it resolves against the .exe's folder. That lets a single
        # value in the shared config.json (e.g. "SystemsData") point every user at
        # the same synced folder without any per-machine absolute path.
        raw = logs_folder or _config_logs_folder()
        if raw:
            raw = os.path.expandvars(raw.strip())
            if not os.path.isabs(raw):
                raw = os.path.join(_app_dir(), raw)
            self.logs = os.path.normpath(raw)
            self.logs_source = "arg" if logs_folder else "config"
        else:
            # DEFAULT: a folder BESIDE the app (the synced SharePoint/OneDrive
            # deployment folder everyone runs the .exe from) -> one shared data set
            # for the whole team. The old default (%USERPROFILE%\Nucor\Systems Home)
            # was a LOCAL per-user path, so each machine kept its own separate list.
            self.logs = os.path.join(_app_dir(), "SystemsData")
            self.logs_source = "default"
        import divisions
        self._store = store          # SharePointHubStore (central) or None (JSON files)
        self.division = division or divisions.load_registry({})[0]
        self.hub = os.path.join(self.logs, divisions.hub_folder_name(self.division))
        self.setups_dir = os.path.join(self.hub, "setups")
        self.changes_dir = os.path.join(self.hub, "changes")
        self.feedback_dir = os.path.join(self.hub, "feedback")
        self.issues_dir = os.path.join(self.hub, "issues")
        self.config_path = os.path.join(self.hub, "nbgw-endpoint-hub-config.json")
        self.model_dept_path = os.path.join(self.hub, "nbgw-model-departments.json")
        self.sites_path = os.path.join(self.hub, "nbgw-nbt-sites.json")
        self.prefs_path = os.path.join(self.hub, "nbgw-division-prefs.json")
        self.sync_lock_path = os.path.join(self.hub, "nbgw-sync-lock.json")
        self.sync_status_path = os.path.join(self.hub, "nbgw-sync-status.json")
        self.upgrades_path = os.path.join(self.hub, "nbgw-upgrade-list.json")
        self.upgrade_log_path = os.path.join(self.hub, "nbgw-upgrade-log.json")
        self.software_path = os.path.join(self.hub, "nbgw-software-inventory.json")
        self.software_rules_path = os.path.join(self.hub, "nbgw-software-rules.json")
        self.hot_spares_path = os.path.join(self.hub, "nbgw-hot-spares.json")
        self.boneyard_path = os.path.join(self.hub, "nbgw-boneyard.json")
        self.clients_path = os.path.join(self.hub, "nbgw-app-clients.json")
        self.perm_baselines_path = os.path.join(self.hub, "nbgw-perm-baselines.json")
        appdata = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        self.history_dir = os.path.join(appdata, "NBGW-Endpoint-Hub",
                                        "config-history" if self.division.get("legacy_data") else "config-history-" + divisions.hub_folder_name(self.division)[len("_EndpointHub_"):])
        dirs = (self.history_dir,) if store else (self.logs, self.hub, self.setups_dir, self.changes_dir,
                                                  self.feedback_dir, self.issues_dir, self.history_dir)
        for d in dirs:
            try:
                os.makedirs(d, exist_ok=True)
            except Exception:
                pass

    # ---- helpers ----------------------------------------------------------
    @staticmethod
    def _safe(name: str) -> str:
        return re.sub(r'[\\/:*?"<>|]', "_", name or "_")

    def _site_bucket(self, site: str) -> str:
        """Group a device's site the way the Upgrade UI's tabs do: a division site
        code, or Other (anything else, including blank)."""
        import divisions
        return divisions.site_bucket(self.division, site)

    # ---- storage layer ----------------------------------------------------
    # Every hub read/write goes through _exists/_read_json/_write/_read_dir/_remove. With a
    # central store, hub paths map to rows (kind, doc); anything else (local config history)
    # stays a plain file.
    def _loc(self, path: str):
        """(kind, doc) when `path` is a hub path the central store owns, else None."""
        if not self._store:
            return None
        from hubstore import kind_for_file
        d = os.path.normcase(os.path.dirname(os.path.normpath(path)))
        name = os.path.basename(path)
        stem = os.path.splitext(name)[0]
        hub = os.path.normcase(os.path.normpath(self.hub))
        logs = os.path.normcase(os.path.normpath(self.logs))
        if d == hub:
            return kind_for_file(stem), "main"
        if os.path.dirname(d) == hub:
            return os.path.basename(d), stem
        if d == logs:
            return "blob", name
        return None

    @staticmethod
    def _write_file(path: str, text: str) -> None:
        # Atomic write: fully write a temp file in the same folder, then replace.
        # OneDrive/SharePoint sync can grab a file mid-write; writing to a temp and
        # os.replace()-ing it means readers/sync never see a half-written JSON.
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    def _write(self, path: str, text: str) -> None:
        loc = self._loc(path)
        if loc:
            self._store.write(loc[0], loc[1], text)
        else:
            self._write_file(path, text)

    def _read_json(self, path: str):
        loc = self._loc(path)
        if loc:
            text = self._store.read(loc[0], loc[1])
            if text is None:
                raise FileNotFoundError(path)
            return json.loads(text)
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)

    def _exists(self, path: str) -> bool:
        loc = self._loc(path)
        return self._store.exists(loc[0], loc[1]) if loc else os.path.exists(path)

    def _remove(self, path: str) -> None:
        loc = self._loc(path)
        if loc:
            self._store.remove(loc[0], loc[1])
        else:
            os.remove(path)

    def _read_dir(self, folder: str) -> list:
        out = []
        if self._store and self._loc(os.path.join(folder, "x.json")):
            kind = self._loc(os.path.join(folder, "x.json"))[0]
            for _doc, text in self._store.list_docs(kind):
                try:
                    out.append(json.loads(text))
                except Exception:
                    pass
        else:
            if not os.path.isdir(folder):
                return out
            for name in os.listdir(folder):
                if not name.lower().endswith(".json"):
                    continue
                try:
                    out.append(self._read_json(os.path.join(folder, name)))
                except Exception:
                    pass

        def best_date(o):
            for k in ("updatedAt", "when", "at", "createdAt"):
                if isinstance(o, dict) and o.get(k):
                    return str(o[k])
            return ""
        out.sort(key=best_date, reverse=True)
        return out

    # ---- session / paths --------------------------------------------------
    def whoami(self) -> dict:
        return {"user": _user(), "machine": _machine(), "logsPath": self.logs,
                "configPath": self.config_path}

    def storage_info(self) -> dict:
        if self._store:                         # central: documents are rows in SharePoint, there is no folder
            return {"store": "sharepoint", "path": "", "hub": "", "source": "central", "app_dir": _app_dir(),
                    "exists": True, "shared": True, "pinned": True, "division": self.division.get("id", "")}
        info = self._file_storage_info()
        info["store"] = "files"
        return info

    def _file_storage_info(self) -> dict:
        """Where the shared data actually lives + how confident we are that it's a
        shared/synced location, so the Configuration → Storage panel can guide the
        Option-A pin. Heuristic only — the path alone can't prove OneDrive sync."""
        p = os.path.normcase(self.logs)
        app = os.path.normcase(_app_dir())
        onedrive_roots = [os.path.normcase(os.environ.get(k, "")) for k in
                          ("OneDrive", "OneDriveCommercial", "OneDriveConsumer")]
        onedrive_roots = [x for x in onedrive_roots if x]
        is_unc = self.logs.startswith("\\\\")
        under_app = p.startswith(app)                      # data sits beside the synced exe
        under_onedrive = any(p.startswith(x) for x in onedrive_roots)
        looks_synced = ("onedrive" in p) or ("sharepoint" in p) or under_onedrive
        pinned = self.logs_source in ("config", "arg")     # set explicitly, not the built-in default
        shared = bool(is_unc or under_app or looks_synced)
        return {
            "path": self.logs,
            "hub": self.hub,
            "source": self.logs_source,          # config | arg | default
            "app_dir": _app_dir(),
            "exists": os.path.isdir(self.hub),
            "shared": shared,
            "pinned": pinned,
        }

    def open_folder(self) -> None:
        try:
            os.makedirs(self.logs, exist_ok=True)
            os.startfile(self.logs)  # type: ignore[attr-defined]
        except Exception:
            pass

    # ---- config -----------------------------------------------------------
    def get_config(self):
        if self._exists(self.config_path):
            try:
                return self._read_json(self.config_path)
            except Exception:
                return None
        return None

    def save_config(self, config: dict, meta: dict | None = None) -> None:
        meta = meta or {}
        text = json.dumps(config, indent=2, ensure_ascii=False)
        self._write(self.config_path, text)
        # local timestamped backup
        try:
            self._write(os.path.join(self.history_dir, f"config_{_stamp()}.json"), text)
        except Exception:
            pass
        # shared program-change event
        change = {
            "when": _now_iso(), "user": _user(), "machine": _machine(),
            "action": meta.get("action", "save"),
            "target": meta.get("target", ""),
            "detail": meta.get("detail", ""),
        }
        cn = f"{_stamp()}-{self._safe(_user())}-{uuid.uuid4().hex[:6]}.json"
        try:
            self._write(os.path.join(self.changes_dir, cn),
                        json.dumps(change, ensure_ascii=False))
        except Exception:
            pass

    # ---- model -> department map ------------------------------------------
    # Shared, no-auth categorization of each model to the department that uses
    # it (Detailing / Engineering / Sales / Shared / ...), so the dashboard can
    # roll up how many of each department's machines are in stock for deployment.
    def get_model_departments(self):
        if self._exists(self.model_dept_path):
            try:
                return self._read_json(self.model_dept_path)
            except Exception:
                return None
        return None

    def save_model_departments(self, data: dict, meta: dict | None = None) -> None:
        meta = meta or {}
        data = data or {}
        self._write(self.model_dept_path,
                    json.dumps(data, indent=2, ensure_ascii=False))
        change = {
            "when": _now_iso(), "user": _user(), "machine": _machine(),
            "action": meta.get("action", "save"),
            "target": meta.get("target", "Model departments"),
            "detail": meta.get("detail", ""),
        }
        cn = f"{_stamp()}-{self._safe(_user())}-{uuid.uuid4().hex[:6]}.json"
        try:
            self._write(os.path.join(self.changes_dir, cn),
                        json.dumps(change, ensure_ascii=False))
        except Exception:
            pass

    # ---- small named JSON documents (platform-level settings such as BG Tools search scopes) ----
    def get_named(self, name: str):
        return self._get_doc(os.path.join(self.hub, "nbgw-" + self._safe(name) + ".json"))

    def put_named(self, name: str, data: dict) -> None:
        self._write(os.path.join(self.hub, "nbgw-" + self._safe(name) + ".json"), json.dumps(data, indent=2, ensure_ascii=False))

    # ---- sync lock + last-sync status (one pair per division; see synclock.py) --------------
    def _get_doc(self, path):
        if self._exists(path):
            try:
                d = self._read_json(path)
                return d if isinstance(d, dict) and d else None
            except Exception:
                return None
        return None

    def get_sync_lock(self):
        return self._get_doc(self.sync_lock_path)

    def put_sync_lock(self, data: dict) -> None:
        self._write(self.sync_lock_path, json.dumps(data, ensure_ascii=False))

    def clear_sync_lock(self) -> None:
        if self._exists(self.sync_lock_path):
            self._remove(self.sync_lock_path)

    def get_sync_status(self):
        return self._get_doc(self.sync_status_path)

    def put_sync_status(self, data: dict) -> None:
        self._write(self.sync_status_path, json.dumps(data, ensure_ascii=False))

    # ---- division preferences (time zone ...) -----------------------------
    # {timezone: "America/Chicago"}. Editable by any app user of the division and by super admins.
    def get_prefs(self) -> dict:
        if self._exists(self.prefs_path):
            try:
                d = self._read_json(self.prefs_path)
                return d if isinstance(d, dict) else {}
            except Exception:
                return {}
        return {}

    def save_prefs(self, data: dict, meta: dict | None = None) -> None:
        meta = meta or {}
        self._write(self.prefs_path, json.dumps(data or {}, indent=2, ensure_ascii=False))
        change = {"when": _now_iso(), "user": _user(), "machine": _machine(),
                  "action": meta.get("action", "save"), "target": meta.get("target", "Division preferences"),
                  "detail": meta.get("detail", "")}
        cn = f"{_stamp()}-{self._safe(_user())}-{uuid.uuid4().hex[:6]}.json"
        try:
            self._write(os.path.join(self.changes_dir, cn), json.dumps(change, ensure_ascii=False))
        except Exception:
            pass

    # ---- NBT Sites (shared, no auth) -------------------------------------
    # {categories:[...], sites:[{id,name,url,icon,mode,category}], pin:"...."}.
    # Groups the embedded web tools by use case; pin gates the Configuration UI.
    def get_sites(self):
        if self._exists(self.sites_path):
            try:
                return self._read_json(self.sites_path)
            except Exception:
                return None
        return None

    def save_sites(self, data: dict, meta: dict | None = None) -> None:
        meta = meta or {}
        self._write(self.sites_path,
                    json.dumps(data or {}, indent=2, ensure_ascii=False))
        change = {
            "when": _now_iso(), "user": _user(), "machine": _machine(),
            "action": meta.get("action", "save"),
            "target": meta.get("target", "NBT Sites"),
            "detail": meta.get("detail", ""),
        }
        cn = f"{_stamp()}-{self._safe(_user())}-{uuid.uuid4().hex[:6]}.json"
        try:
            self._write(os.path.join(self.changes_dir, cn),
                        json.dumps(change, ensure_ascii=False))
        except Exception:
            pass

    # ---- Group baselines (shared, no auth) -------------------------------
    # Per-department "expected" groups the majority of a department holds, across ALL
    # Entra groups, derived from an analysis and then curated by IT. Shape:
    #   {"keyword": "", "threshold": 0.7,
    #    "departments": {
    #       "<dept name>": {"updated": iso, "total": N, "domain": "",
    #                       "groups": [{"name","count","pct","expected"}]}}}
    # Drives the "Missing Groups" tool so we can spot users who lack groups their
    # department peers have.
    def get_perm_baselines(self):
        if self._exists(self.perm_baselines_path):
            try:
                return self._read_json(self.perm_baselines_path)
            except Exception:
                return None
        return None

    def save_perm_baselines(self, data: dict, meta: dict | None = None) -> None:
        meta = meta or {}
        self._write(self.perm_baselines_path,
                    json.dumps(data or {}, indent=2, ensure_ascii=False))
        change = {
            "when": _now_iso(), "user": _user(), "machine": _machine(),
            "action": meta.get("action", "save"),
            "target": meta.get("target", "Permission baselines"),
            "detail": meta.get("detail", ""),
        }
        cn = f"{_stamp()}-{self._safe(_user())}-{uuid.uuid4().hex[:6]}.json"
        try:
            self._write(os.path.join(self.changes_dir, cn),
                        json.dumps(change, ensure_ascii=False))
        except Exception:
            pass

    def _change(self, target: str, detail: str) -> None:
        """Write one shared program-change event (best-effort)."""
        change = {"when": _now_iso(), "user": _user(), "machine": _machine(),
                  "action": "save", "target": target, "detail": detail}
        cn = f"{_stamp()}-{self._safe(_user())}-{uuid.uuid4().hex[:6]}.json"
        try:
            self._write(os.path.join(self.changes_dir, cn),
                        json.dumps(change, ensure_ascii=False))
        except Exception:
            pass

    # ---- upgrade list (shared, no auth) ----------------------------------
    # A prioritized queue of devices awaiting a hardware upgrade. Each device is
    # captured from the aged-device or In Use list with a priority (1-5, 5 highest)
    # and notes; the list is hand-orderable (drag) within each site and checked off
    # when the upgrade is done, which moves the record to the completion log.
    # {items:[{id,serial,device_name,model,user,site,priority,notes,added_by,added_at}]}
    def get_upgrades(self):
        if self._exists(self.upgrades_path):
            try:
                return self._read_json(self.upgrades_path)
            except Exception:
                return None
        return None

    def get_upgrade_log(self):
        if self._exists(self.upgrade_log_path):
            try:
                return self._read_json(self.upgrade_log_path)
            except Exception:
                return None
        return None

    def _write_upgrades(self, data: dict) -> None:
        self._write(self.upgrades_path,
                    json.dumps({"items": (data or {}).get("items") or []},
                               indent=2, ensure_ascii=False))

    def add_upgrade(self, device: dict, priority=3, notes: str = "", actor: str = "") -> dict:
        device = device or {}
        data = self.get_upgrades() or {"items": []}
        items = data.get("items") or []
        serial = (device.get("serial") or "").strip()
        site = (device.get("site") or device.get("site_tag") or "").strip()
        try:
            pr = max(1, min(5, int(priority)))
        except (TypeError, ValueError):
            pr = 3
        notes = (notes or "").strip()
        who = actor or _user()
        now = _now_iso()
        # already queued? update its priority/notes/site in place (no duplicate) and
        # record who/when in the history.
        existing = next((it for it in items
                         if (it.get("serial") or "").strip().lower() == serial.lower()), None)
        if existing:
            existing["priority"] = pr
            if notes:
                existing["notes"] = notes
            if site:
                existing["site"] = site
            existing["updated_by"] = who
            existing["updated_at"] = now
            existing.setdefault("history", []).append(
                {"at": now, "by": who, "action": "updated", "priority": pr, "notes": notes})
        else:
            rec = {
                "id": "up-" + datetime.now().strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6],
                "serial": serial,
                "device_name": device.get("device_name", "") or "",
                "model": device.get("model", "") or "",
                "user": device.get("user", "") or "",
                "site": site,
                "priority": pr,
                "notes": notes,
                "added_by": who,
                "added_at": now,
                "updated_by": who,
                "updated_at": now,
                "history": [{"at": now, "by": who, "action": "added", "priority": pr, "notes": notes}],
            }
            # default placement: grouped by priority (highest first) within the same
            # site bucket (LTR/BRI/Other); drag can override afterward.
            bucket = self._site_bucket(site)
            insert_at = len(items)
            for i, it in enumerate(items):
                if self._site_bucket(it.get("site")) == bucket and int(it.get("priority", 3) or 3) < pr:
                    insert_at = i
                    break
            items.insert(insert_at, rec)
        data["items"] = items
        self._write_upgrades(data)
        self._change("Upgrade list", f"Added {serial} (P{pr})")
        self.clear_upgrade_ignored(serial)             # someone chose to queue it again
        return {"items": items}

    def save_upgrades(self, data: dict, actor: str = "") -> dict:
        """Persist the item order/edits exactly as given (used by drag-reorder)."""
        self._write_upgrades(data)
        return {"items": (data or {}).get("items") or []}

    def ensure_upgrades(self, devices: list, actor: str = "") -> dict:
        """Keep the upgrade list in sync with the dashboard's 'needs upgrade' set:
        auto-add any of `devices` (aged machines) not already queued. Default priority
        scales with hardware age; tagged source='auto' with a note + history. Only
        writes when there's something new (idempotent), so it's safe to call on every
        dashboard load. Never removes user-added or edited entries."""
        data = self.get_upgrades() or {"items": []}
        items = data.get("items") or []
        have = {(it.get("serial") or "").strip().lower() for it in items}
        ignored = self.get_upgrade_ignored()          # completed or removed before: never queue those again by themselves
        now = _now_iso()
        who = actor or _user()
        added = 0
        for d in (devices or []):
            serial = (d.get("serial") or "").strip()
            if not serial or serial.lower() in have or serial.lower() in ignored:
                continue
            try:
                age = int(d.get("age") or 0)
            except (TypeError, ValueError):
                age = 0
            pr = d.get("priority")
            if isinstance(pr, int) and 1 <= pr <= 5:
                pass
            else:
                pr = max(1, min(5, age - 3)) if age else 3    # 5yr->2, 6->3, 7->4, 8+->5
            reasons = d.get("reasons")
            note = ("Auto-added: " + "; ".join(reasons)) if reasons else \
                f"Auto-added: processor released {d.get('year', '?')} ({age or '?'} yrs old)"
            items.append({
                "id": "up-" + datetime.now().strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6],
                "serial": serial,
                "device_name": d.get("device_name", "") or "",
                "model": d.get("model", "") or "",
                "user": d.get("user", "") or "",
                "site": (d.get("site") or d.get("site_tag") or "").strip(),
                "priority": pr,
                "notes": note,
                "source": "auto",
                "added_by": who,
                "added_at": now,
                "updated_by": who,
                "updated_at": now,
                "history": [{"at": now, "by": who, "action": "auto-added", "priority": pr, "notes": note}],
            })
            have.add(serial.lower())
            added += 1
        if added:
            self._write_upgrades({"items": items})
            self._change("Upgrade list", f"Auto-added {added} aged device(s) from Needs upgrade")
        return {"added": added, "items": items}

    # ---- devices the automatic rules must not queue again (completed or removed from the list) ----
    def get_upgrade_ignored(self) -> dict:
        return ((self.get_named("upgrade-ignore") or {}).get("serials")) or {}

    def _ignore_upgrade(self, serial: str, why: str, actor: str = "") -> None:
        serial = (serial or "").strip().lower()
        if not serial:
            return
        try:
            cur = self.get_upgrade_ignored()
            cur[serial] = {"why": why, "by": actor or _user(), "at": _now_iso()}
            self.put_named("upgrade-ignore", {"serials": cur})
        except Exception:
            pass                                       # losing this only means a device could be re-queued once

    def clear_upgrade_ignored(self, serial: str | None = None) -> int:
        """Forget one serial (or all with None) so the rules may queue it again. Returns how many were forgotten."""
        try:
            cur = self.get_upgrade_ignored()
            if serial is not None:
                n = 1 if cur.pop((serial or "").strip().lower(), None) else 0
            else:
                n, cur = len(cur), {}
            if n:
                self.put_named("upgrade-ignore", {"serials": cur})
            return n
        except Exception:
            return 0

    def update_upgrade(self, item_id: str, priority=None, notes=None, actor: str = "") -> dict:
        """Edit an item's priority and/or notes, stamping who/when and appending to
        its history (audit tag). Only the fields provided are changed."""
        data = self.get_upgrades() or {"items": []}
        items = data.get("items") or []
        it = next((x for x in items if x.get("id") == item_id), None)
        if it is None:
            return {"items": items}
        who = actor or _user()
        now = _now_iso()
        if priority is not None:
            try:
                it["priority"] = max(1, min(5, int(priority)))
            except (TypeError, ValueError):
                pass
        if notes is not None:
            it["notes"] = (notes or "").strip()
        it["updated_by"] = who
        it["updated_at"] = now
        it.setdefault("history", []).append(
            {"at": now, "by": who, "action": "updated",
             "priority": it.get("priority"), "notes": it.get("notes", "")})
        self._write_upgrades({"items": items})
        self._change("Upgrade list", f"Edited {it.get('serial', '')} (P{it.get('priority')})")
        return {"items": items}

    def begin_upgrade(self, item_id: str, setup_id: str, actor: str = "") -> dict:
        """Mark an item as being worked on: status 'working', who started it + when,
        and link it to the Endpoint-Provisioning setup so the list can show progress."""
        data = self.get_upgrades() or {"items": []}
        items = data.get("items") or []
        it = next((x for x in items if x.get("id") == item_id), None)
        if it is None:
            return {"items": items}
        who = actor or _user()
        now = _now_iso()
        it["status"] = "working"
        it["started_by"] = who
        it["started_at"] = now
        it["setup_id"] = setup_id
        it.setdefault("history", []).append(
            {"at": now, "by": who, "action": "began upgrade", "setup_id": setup_id})
        self._write_upgrades({"items": items})
        self._change("Upgrade list", f"Began upgrade {it.get('serial', '')}")
        return {"items": items}

    def remove_upgrade(self, item_id: str, actor: str = "") -> dict:
        """Drop an item WITHOUT logging it (for a mistaken add)."""
        data = self.get_upgrades() or {"items": []}
        gone = next((it for it in (data.get("items") or []) if it.get("id") == item_id), None)
        items = [it for it in (data.get("items") or []) if it.get("id") != item_id]
        self._write_upgrades({"items": items})
        if gone:
            self._ignore_upgrade(gone.get("serial", ""), "removed", actor)
        return {"items": items}

    def complete_upgrade(self, item_id: str, actor: str = "") -> dict:
        """Check an item off: remove it from the list and append it to the log."""
        data = self.get_upgrades() or {"items": []}
        items = data.get("items") or []
        rec = next((it for it in items if it.get("id") == item_id), None)
        items = [it for it in items if it.get("id") != item_id]
        self._write_upgrades({"items": items})
        if rec:
            log = self.get_upgrade_log() or {"entries": []}
            entry = dict(rec)
            entry["completed_by"] = actor or _user()
            entry["completed_at"] = _now_iso()
            log.setdefault("entries", []).insert(0, entry)
            self._write(self.upgrade_log_path,
                        json.dumps(log, indent=2, ensure_ascii=False))
            self._change("Upgrade list", f"Completed {rec.get('serial', '')}")
            self._ignore_upgrade(rec.get("serial", ""), "completed", actor)
        return {"items": items}

    # ---- software inventory (cached from Intune) + mandatory rules --------
    def get_software(self):
        if self._exists(self.software_path):
            try:
                return self._read_json(self.software_path)
            except Exception:
                return None
        return None

    def save_software(self, data: dict) -> None:
        self._write(self.software_path, json.dumps(data or {}, ensure_ascii=False))

    def get_software_rules(self):
        if self._exists(self.software_rules_path):
            try:
                return self._read_json(self.software_rules_path)
            except Exception:
                return None
        return None

    def save_software_rules(self, data: dict, actor: str = "") -> dict:
        """Per-department mandatory-app overrides (`rules`) and the automatic-rule settings (`auto`).
        A save that carries only `rules` keeps the stored `auto`."""
        data = data or {}
        rules = data.get("rules") or []
        doc = {"rules": rules}
        auto = data["auto"] if "auto" in data else ((self.get_software_rules() or {}).get("auto"))
        if auto:
            doc["auto"] = auto
        self._write(self.software_rules_path, json.dumps(doc, indent=2, ensure_ascii=False))
        self._change("Software rules", f"{len(rules)} mandatory rule(s)" + (f" · auto: {auto}" if "auto" in data else ""))
        return doc

    # ---- setups -----------------------------------------------------------
    def get_setups(self) -> list:
        return self._read_dir(self.setups_dir)

    def save_setup(self, entry: dict, html: str = "", filename: str = "") -> dict:
        entry = dict(entry or {})
        sid = str(entry.get("id") or uuid.uuid4().hex)
        entry["id"] = sid
        path = os.path.join(self.setups_dir, self._safe(sid) + ".json")
        # preserve createdAt / createdBy across updates
        created_by = _user()
        if self._exists(path):
            try:
                prev = self._read_json(path)
                created_by = prev.get("createdBy") or created_by
                if not entry.get("createdAt") and prev.get("createdAt"):
                    entry["createdAt"] = prev["createdAt"]
            except Exception:
                pass
        entry.setdefault("createdAt", _now_iso())
        entry["createdBy"] = created_by
        entry["updatedBy"] = _user()
        entry["updatedAt"] = _now_iso()
        self._write(path, json.dumps(entry, ensure_ascii=False))
        if html and filename:
            try:
                if not self._store:
                    os.makedirs(self.logs, exist_ok=True)
                self._write(os.path.join(self.logs, self._safe(filename)), html)
            except Exception:
                pass
        return {"where": self.logs, "id": sid}

    def cancel_setup(self, setup_id: str, reason: str = "", actor: str = "") -> dict:
        """Cancel an in-progress setup: delete its shared record, LOG the reason
        (who/when/subject), and if it was started from an upgrade (Begin Upgrade),
        revert that upgrade entry from 'working' back to queued."""
        who = actor or _user()
        reason = (reason or "").strip()
        path = os.path.join(self.setups_dir, self._safe(setup_id) + ".json")
        subject = stype = ""
        try:
            rec = self._read_json(path)
            subject = rec.get("subject") or ""
            stype = rec.get("type") or ""
        except Exception:
            pass
        try:
            self._remove(path)
        except OSError:
            pass
        # revert any upgrade entry linked to this setup
        data = self.get_upgrades() or {"items": []}
        items = data.get("items") or []
        reverted = False
        for it in items:
            if it.get("setup_id") == setup_id:
                it["status"] = ""
                it["setup_id"] = ""
                it["started_by"] = ""
                it["started_at"] = ""
                it.setdefault("history", []).append(
                    {"at": _now_iso(), "by": who, "action": "upgrade setup cancelled", "notes": reason})
                reverted = True
        if reverted:
            self._write_upgrades({"items": items})
        label = ("user" if stype == "user" else "computer") + " setup"
        self._change("Setup cancelled",
                     f"{label} '{subject or '(unnamed)'}' cancelled by {who}: {reason}")
        return {"ok": True, "subject": subject, "reverted": reverted}

    # ---- issues board documents (platform hub; see issues.py) -------------------
    def _issue_path(self, issue_id: str) -> str:
        return os.path.join(self.issues_dir, self._safe(issue_id) + ".json")

    def list_issues(self) -> list:
        return [d for d in self._read_dir(self.issues_dir) if isinstance(d, dict) and d.get("id")]

    def get_issue(self, issue_id: str):
        return self._get_doc(self._issue_path(issue_id))

    def put_issue(self, doc: dict) -> None:
        self._write(self._issue_path(doc["id"]), json.dumps(doc, ensure_ascii=False))

    def delete_issue(self, issue_id: str) -> None:
        p = self._issue_path(issue_id)
        if self._exists(p):
            self._remove(p)

    # ---- issue attachments (binary files; Hub Files library in central mode, a folder otherwise) ----
    def _att_path(self, name: str) -> str:
        return os.path.join(self.hub, "attachments", self._safe(name))

    def put_attachment(self, name: str, data: bytes) -> None:
        if self._store:
            self._store.put_bytes(self._safe(name), data)
            return
        p = self._att_path(name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = f"{p}.{os.getpid()}.tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, p)

    def get_attachment(self, name: str):
        if self._store:
            return self._store.get_bytes(self._safe(name))
        try:
            with open(self._att_path(name), "rb") as f:
                return f.read()
        except OSError:
            return None

    def delete_attachment(self, name: str) -> None:
        try:
            if self._store:
                self._store._blob_del(self._safe(name))
            else:
                os.remove(self._att_path(name))
        except Exception:
            pass

    # ---- changes / feedback ----------------------------------------------
    def get_changes(self) -> list:
        return self._read_dir(self.changes_dir)

    def get_feedback(self) -> list:
        return self._read_dir(self.feedback_dir)

    def add_feedback(self, item: dict) -> dict:
        item = dict(item or {})
        fid = "fb-" + datetime.now().strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6]
        rec = {
            "id": fid,
            "type": item.get("type", "bug"),
            "title": item.get("title", ""),
            "detail": item.get("detail", ""),
            "status": "open",
            "by": _user(), "machine": _machine(),
            "at": _now_iso(),
        }
        self._write(os.path.join(self.feedback_dir, fid + ".json"),
                    json.dumps(rec, ensure_ascii=False))
        return {"id": fid}

    # ---- dashboard rollup -------------------------------------------------
    def active_reservations(self) -> dict:
        """Stock devices currently held by a computer setup (reservedSerial on the
        setup record). Keyed by serial. A cancelled setup deletes its record, so its
        reservation is released automatically. Used to subtract from In Stock counts
        so the dashboard reflects what's genuinely available."""
        out = {}
        for s in self.get_setups():
            if s.get("type") != "computer":
                continue
            serial = (s.get("reservedSerial") or "").strip()
            if not serial:
                continue
            out[serial] = {
                "setup_id": s.get("id", ""),
                "subject": s.get("subject", ""),
                "dept": s.get("reservedDept", ""),
                "model": s.get("reservedModel", ""),
                "site": s.get("reservedSite", ""),
                "status": s.get("status", ""),
                "by": s.get("updatedBy") or s.get("createdBy") or "",
                "at": s.get("updatedAt") or s.get("createdAt") or "",
            }
        return out

    # ---- hot spares (imaged, ready-to-deploy loaners; shared, no auth) ----
    # Grouped by site (LTR/BRI) x department bucket. Each record carries the serial
    # (to enrich live from Intune) plus manual holding notes. Live specs/OS/check-in/
    # compliance are joined in app.py at display time.
    HOT_SPARE_DEPTS = ["Detailing", "Engineering", "Other"]

    def get_hot_spares(self) -> list:
        if self._exists(self.hot_spares_path):
            try:
                data = self._read_json(self.hot_spares_path)
                return data.get("items") or []
            except Exception:
                return []
        return []

    def _write_hot_spares(self, items: list) -> None:
        self._write(self.hot_spares_path,
                    json.dumps({"items": items or []}, indent=2, ensure_ascii=False))

    def add_hot_spare(self, entry: dict, actor: str = "") -> dict:
        entry = dict(entry or {})
        who = actor or _user()
        items = self.get_hot_spares()
        serial = (entry.get("serial") or "").strip()
        rec = {
            "id": "hs-" + datetime.now().strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6],
            "serial": serial,
            "hostname": (entry.get("hostname") or "").strip(),
            "site": (entry.get("site") or "").strip().upper(),
            "dept": (entry.get("dept") or "Other").strip(),
            "notes": (entry.get("notes") or "").strip(),
            "added_by": who, "added_at": _now_iso(),
            "updated_by": who, "updated_at": _now_iso(),
        }
        items.append(rec)
        self._write_hot_spares(items)
        self._change("Hot spare added",
                     f"{rec['hostname'] or rec['serial'] or '(unnamed)'} "
                     f"[{rec['site']} · {rec['dept']}] by {who}")
        return {"id": rec["id"]}

    def update_hot_spare(self, spare_id: str, fields: dict, actor: str = "") -> dict:
        who = actor or _user()
        items = self.get_hot_spares()
        found = None
        for it in items:
            if it.get("id") == spare_id:
                for k in ("serial", "hostname", "site", "dept", "notes"):
                    if k in (fields or {}):
                        v = (fields[k] or "").strip()
                        it[k] = v.upper() if k == "site" else v
                it["updated_by"] = who
                it["updated_at"] = _now_iso()
                found = it
                break
        if not found:
            return {"ok": False, "error": "Hot spare not found."}
        self._write_hot_spares(items)
        self._change("Hot spare updated",
                     f"{found.get('hostname') or found.get('serial') or '(unnamed)'} by {who}")
        return {"ok": True}

    def remove_hot_spare(self, spare_id: str, reason: str = "", actor: str = "") -> dict:
        who = actor or _user()
        items = self.get_hot_spares()
        gone = next((it for it in items if it.get("id") == spare_id), None)
        items = [it for it in items if it.get("id") != spare_id]
        self._write_hot_spares(items)
        if gone:
            self._change("Hot spare removed",
                         f"{gone.get('hostname') or gone.get('serial') or '(unnamed)'} "
                         f"by {who}" + (f": {reason}" if reason else ""))
        return {"ok": True}

    # ---- boneyard snapshots (display/audit metadata for retired devices) ----
    # The authoritative "this device is retired" flag is the New Stock Status column
    # (="Boneyard") in SharePoint. This file just keeps the extra context that the
    # New Stock row can't hold (former hostname, user, last check-in, when/why/who,
    # and where it was last seen) so the Boneyard tab is useful for troubleshooting.
    def get_boneyard(self) -> dict:
        if self._exists(self.boneyard_path):
            try:
                return self._read_json(self.boneyard_path).get("items") or {}
            except Exception:
                return {}
        return {}

    def set_boneyard(self, serial: str, snap: dict) -> None:
        serial = (serial or "").strip().upper()
        if not serial:
            return
        items = self.get_boneyard()
        items[serial] = {**(snap or {}), "serial": serial}
        self._write(self.boneyard_path, json.dumps({"items": items}, indent=2, ensure_ascii=False))

    def remove_boneyard(self, serial: str) -> None:
        serial = (serial or "").strip().upper()
        items = self.get_boneyard()
        if serial in items:
            items.pop(serial, None)
            self._write(self.boneyard_path, json.dumps({"items": items}, indent=2, ensure_ascii=False))

    # ---- app client registry (who's running which version) ----------------
    def record_client(self, version: str) -> None:
        """Heartbeat: record this machine's user + app version on launch, keyed by
        machine, so an admin can see which version everyone is running."""
        machine = _machine()
        if not machine:
            return
        clients = {}
        if self._exists(self.clients_path):
            try:
                clients = self._read_json(self.clients_path).get("clients") or {}
            except Exception:
                clients = {}
        clients[machine] = {"machine": machine, "user": _user(),
                            "version": str(version or "?"), "last_seen": _now_iso()}
        try:
            self._write(self.clients_path, json.dumps({"clients": clients}, indent=2, ensure_ascii=False))
        except Exception:
            pass

    def get_clients(self) -> list:
        if not self._exists(self.clients_path):
            return []
        try:
            clients = self._read_json(self.clients_path).get("clients") or {}
        except Exception:
            return []
        return sorted(clients.values(), key=lambda c: str(c.get("last_seen", "")), reverse=True)

    def setup_stats(self) -> dict:
        setups = self.get_setups()
        total = len(setups)
        complete = sum(1 for s in setups if s.get("status") == "complete")
        in_progress = total - complete
        computer = sum(1 for s in setups if s.get("type") == "computer")
        user = sum(1 for s in setups if s.get("type") == "user")
        # simple 14-day activity by updated date
        recent = setups[:8]
        open_feedback = sum(1 for f in self.get_feedback() if f.get("status") != "closed")
        return {
            "total": total, "complete": complete, "in_progress": in_progress,
            "computer": computer, "user": user,
            "recent": recent, "open_feedback": open_feedback,
        }


def hub_for(gc) -> "Hub":
    """The Hub for `gc`'s ACTIVE division, wherever its data lives (local sandbox, central SharePoint rows, or files)."""
    if gc.data_mode == "local":
        import localstore
        return Hub(logs_folder=localstore.hub_logs_dir(gc.division["id"]), division=gc.division)
    if gc._central:
        from hubstore import SharePointHubStore   # central site: hub data lives in SharePoint rows
        return Hub(division=gc.division, store=SharePointHubStore(gc))
    return Hub(division=gc.division)


TEMPLATE_ID = "_template"
PLATFORM_ID = "_platform"


def pseudo_hub_for(gc, div_id: str, name: str) -> "Hub":
    """A hub for a platform-level pseudo-division: no Divisions row, never in the switcher, edited by super admins."""
    div = {"id": div_id, "name": name, "company_name": "", "legacy_data": False, "sites": []}
    if gc.data_mode == "local":
        import localstore
        return Hub(logs_folder=localstore.hub_logs_dir(div_id), division=div)
    if gc._central:
        from hubstore import SharePointHubStore
        return Hub(division=div, store=SharePointHubStore(gc, div_id=div_id))
    return Hub(division=div)


def template_hub_for(gc) -> "Hub":
    """The platform-level TEMPLATE hub (checklists new divisions start from)."""
    return pseudo_hub_for(gc, TEMPLATE_ID, "Template checklists")


def platform_hub_for(gc) -> "Hub":
    """Platform-wide documents (BG Tools search scopes ...)."""
    return pseudo_hub_for(gc, PLATFORM_ID, "Platform settings")
