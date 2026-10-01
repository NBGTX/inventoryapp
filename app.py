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

import os
import sys
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

    def _client(self):
        if self._gc is None:
            self._gc = self._GraphClient()
        return self._gc

    def _hubc(self):
        if self._hub is None:
            from hub import Hub  # lazy import
            gc = self._client()
            if gc.data_mode == "local":
                import localstore
                self._hub = Hub(logs_folder=localstore.hub_logs_dir(gc.division["id"]), division=gc.division)
            elif gc._central:
                from hubstore import SharePointHubStore   # central site: hub data lives in SharePoint rows
                self._hub = Hub(division=gc.division, store=SharePointHubStore(gc))
            else:
                self._hub = Hub(division=gc.division)
        return self._hub

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
            return {"ok": True, "super_admin": True, "settings": rows}
        except Exception as e:
            return self._fail(e)

    def set_master_setting(self, key: str, value: str, secret: bool = False, description: str = "") -> dict:
        """Create/update one master setting (super admin only). Value is never logged."""
        try:
            self._client().set_setting(key, value, secret=bool(secret), description=description or "")
            return {"ok": True}
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
            info = gc.snapshot_prod()
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
            gc.refresh_registry()
            vis = gc.visible_registry()
            if gc.division["id"] not in [d["id"] for d in vis]:
                gc.set_division(vis[0]["id"])      # saved choice no longer allowed
                self._hub = None
            return {"ok": True, "current": gc.division["id"],
                    "divisions": [divisions.public(d) for d in vis]}
        except Exception as e:
            return self._fail(e)

    def switch_division(self, div_id: str) -> dict:
        """Make `div_id` the active division. Local-only (no production writes): resets
        the Graph/Hub caches so the next call reads the new division's site and data."""
        try:
            import divisions
            gc = self._client()
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
            return {"ok": True, "signed_in": True, "account": gc.account_name}
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

            # Specs always come from the vendor API (Lenovo/Dell), per machine.
            # Model Spec References is intentionally NOT consulted.
            m = (manufacturer or "").lower()
            vendor = gc.lookup_lenovo(serial) if m == "lenovo" else (
                gc.lookup_dell(serial) if m == "dell" else None)
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

    def open_external(self, url: str) -> dict:
        """Open a URL in the user's DEFAULT system browser (Edge), which carries
        their Windows/Entra SSO — so sign-in portals auto-sign-in like normal web
        browsing. Used for sites set to 'browser' mode."""
        try:
            import webbrowser
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
    def run_sync(self) -> dict:
        try:
            from sync import run_sync
            return {"ok": True, **run_sync(self._client(), commit=True)}
        except Exception as e:
            return self._fail(e)

    def enrich_inventory(self) -> dict:
        """Fill missing In Use specs/warranty from the vendor (bounded per call)."""
        try:
            from sync import enrich_in_use
            return {"ok": True, **enrich_in_use(self._client(), commit=True)}
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

    def software_save_rules(self, rules: dict) -> dict:
        try:
            return {"ok": True, **self._hubc().save_software_rules(rules or {}, self._actor())}
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
        try:
            return {"ok": True, "config": self._hubc().get_config()}
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
                "stale": bool(stale_days is not None and stale_days > 30),
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
            domain = (self._client().cfg.get("ad_domain") or "bg.nucorsteel.local")
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
                "ad_error": ad_error, "ad_domain": (self._client().cfg.get("ad_domain") or "bg.nucorsteel.local")}

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
        return (self._client().cfg.get("timesheet_sql_server") or "BGBRISQL07")

    def ts_search(self, query: str) -> dict:
        """Find employees by first or last name in NBSEmployeeInfo.dbo.SAP_Interface."""
        q = (query or "").strip()
        if len(q) < 2:
            return {"ok": True, "employees": []}
        try:
            from sqltools import run
            r = run(self._ts_server(), "NBSEmployeeInfo",
                    "SELECT TOP 25 EmployeeID, FirstName, LastName, Department "
                    "FROM dbo.SAP_Interface WHERE FirstName LIKE @q OR LastName LIKE @q "
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
        """Last 8 weeks' lock status for an employee from NBSTimesheet.dbo.WeekLocked."""
        emp = (employid or "").strip()
        if not emp:
            return {"ok": False, "error": "No employee id."}
        try:
            from sqltools import run
            r = run(self._ts_server(), "NBSTimesheet",
                    "SELECT TOP 8 FiscalYear, FiscalWeek, Locked FROM dbo.WeekLocked "
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
            r = run(self._ts_server(), "NBSTimesheet",
                    "UPDATE dbo.WeekLocked SET Locked = 0 "
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
            cfg = self._client().cfg
        except Exception:
            cfg = {}
        locs = cfg.get("permission_locations")
        if not isinstance(locs, list) or not locs:
            locs = self._BG_LOCATIONS_DEFAULT
        out = [{"label": (l.get("label") or l.get("domain") or ""), "domain": (l.get("domain") or "").strip().lower()}
               for l in locs if isinstance(l, dict) and l.get("domain")]
        divs = cfg.get("permission_divisions")
        if not isinstance(divs, list) or not divs:
            divs = self._BG_DIVISIONS_DEFAULT
        dout = [{"label": (d.get("label") or d.get("company") or ""), "company": (d.get("company") or "").strip()}
                for d in divs if isinstance(d, dict) and d.get("company")]
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
        try:
            return self._client().division["company_name"]
        except Exception:
            return "Nucor Buildings Group West"
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
        try:
            self._hubc().open_folder()
            return {"ok": True}
        except Exception as e:
            return self._fail(e)

    def hub_storage_info(self) -> dict:
        try:
            return {"ok": True, **self._hubc().storage_info()}
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

    def hub_get_sites(self) -> dict:
        try:
            return {"ok": True, "data": self._hubc().get_sites()}
        except Exception as e:
            return self._fail(e)

    def hub_save_sites(self, data: dict, meta: dict = None) -> dict:
        try:
            self._hubc().save_sites(data or {}, meta or {})
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
            return {"ok": True, "data": h.get_upgrades(), "log": h.get_upgrade_log()}
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
            # "Needs upgrade": processor generation released 5+ years ago
            this_year = _today.year
            needs_upgrade = []
            for r, src in tagged:
                yr = cpu_release_year(r.get("cpu"))
                if yr and (this_year - yr) >= 5:
                    needs_upgrade.append({"serial": r.get("serial", ""), "model": r.get("model", ""),
                                          "cpu": r.get("cpu", ""), "user": r.get("user", ""),
                                          "site": r.get("site_tag", ""), "device_name": r.get("device_name", ""),
                                          "year": yr, "age": this_year - yr, "source": src})
            needs_upgrade.sort(key=lambda x: (x["year"], x["serial"]))  # oldest first
            # keep the shared upgrade list in sync: auto-add any aged device not
            # already queued (idempotent — only writes when there's something new).
            try:
                self._hubc().ensure_upgrades(needs_upgrade, self._actor())
            except Exception:
                pass
            # devices that haven't checked in to Intune in 30+ days (drill-down). Spans
            # both lists — a stock/loaner device can go stale too; Source shows which.
            stale_checkin = []
            for r, src in tagged:
                lc = (r.get("last_checkin") or "")[:10]
                if not lc:
                    continue
                try:
                    days = (_today - date.fromisoformat(lc)).days
                except ValueError:
                    continue
                if days > 30:
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
    try:
        main()
    except Exception:
        traceback.print_exc()
        input("\nPress Enter to close...")
