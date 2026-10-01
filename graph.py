#!/usr/bin/env python3
"""
Graph backend for the NBGW inventory desktop app.

Handles:
  - Entra sign-in via MSAL (public client, PKCE, NO secret stored)
  - Intune managed-device lookup by serial number
  - SharePoint list read/write for New Stock, In Use, and Model Spec References

Column names are resolved dynamically from each list's /columns endpoint, so we
map friendly display names ("Serial Number", "RAM") to SharePoint internal names
("Title", "Memory_x0028_RAM_x0029_") at runtime instead of hardcoding them.
"""
from __future__ import annotations

import base64
import csv
import datetime as _dt
import io
import json
import os
import re
import sys
import threading
import time
import warnings
import zipfile
from urllib.parse import quote

warnings.filterwarnings("ignore", message="Unable to find acceptable character detection")

import msal
import requests

# Verify TLS against the OS (Windows) trust store, which includes the corporate
# proxy's root CA. Without this, HTTPS to Graph/Lenovo fails with
# CERTIFICATE_VERIFY_FAILED behind the intercepting proxy. This keeps full
# verification on (never verify=False).
try:
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass

GRAPH = "https://graph.microsoft.com/v1.0"
LENOVO_WARRANTY_URL = "https://supportapi.lenovo.com/v2.5/warranty"
LENOVO_PRODUCT_URL = "https://supportapi.lenovo.com/v2.5/product"

# Map our logical field -> candidate column display/internal names (lowercased).
# The resolver matches the real SharePoint columns so we don't depend on exact
# internal names (e.g. "Primary User" -> PrimaryUser vs Primary_x0020_User).
FIELD_ALIASES = {
    "serial": ["title", "serial number", "serialnumber", "serial"],
    "manufacturer": ["manufacturer", "make", "vendor"],
    "model": ["model"],
    "site_tag": ["site tag", "sitetag", "site"],
    "cpu": ["cpu", "processor"],
    "ram": ["memory (ram)", "ram", "memory"],
    "storage": ["storage", "disk", "ssd", "hard drive"],
    "user": ["primary user", "assigned user", "primaryuser", "user"],
    "device_name": ["device name", "devicename", "computer name", "hostname", "host name", "device"],
    "os_version": ["os version", "osversion", "operating system"],
    "os_install": ["os install date", "osinstalldate", "install date", "os install"],
    "last_checkin": ["last sign in", "last sign-in", "last check in", "last check-in",
                     "lastsignin", "lastcheckin", "last sync", "last seen"],
    "date_added": ["date added", "dateadded", "added"],
    "warranty": ["warranty expiration", "warranty until", "warranty end", "warranty"],
    "mfa": ["mfa", "mfa status", "mfa registered", "mfa configured", "multifactor",
            "multi-factor", "multi factor"],
    "status": ["status", "device status", "state", "lifecycle"],
    "division": ["division"],
}
# Central multi-division store (config.json "central": {site_host, site_path, lists}).
# Default list names match docs/MANUAL_LIST_SETUP.md. Lists in _DIVISION_SCOPED hold rows for
# every division, separated by an indexed Division column.
DEFAULT_CENTRAL_LISTS = {
    "divisions": "Inventory - Divisions",
    "new_stock": "Inventory - New Stock",
    "in_use": "Inventory - In Use",
    "model_specs": "Inventory - Model Specs",
    "log": "Inventory - Activity Log",
    "hub_items": "Inventory - Hub Items",
    "master_settings": "Inventory - Master Settings",
}
_DIVISION_SCOPED = ("new_stock", "in_use", "log")
SCOPES = [
    "User.Read",
    "DeviceManagementManagedDevices.Read.All",
    "Sites.ReadWrite.All",
]
# Optional directory read. Unlocks three things for co-managed/hybrid devices that
# have no user on the Intune record: the assigned user (Azure AD device registered
# owner), the user's city (-> LTR/BRI site), and their office location. Requested
# best-effort on top of SCOPES; if the app registration doesn't have it consented,
# sign-in still succeeds with the core scopes and these are skipped.
DIR_SCOPE = "Directory.Read.All"
# Optional audit-log read. Unlocks the per-user MFA registration report
# (/reports/authenticationMethods/userRegistrationDetails -> isMfaRegistered).
# Requested best-effort alongside DIR_SCOPE; if the app registration doesn't have it
# consented (and the signed-in user isn't a Reports/Security Reader, Security Admin,
# or Global Reader), sign-in still succeeds and the MFA column just stays blank.
AUDITLOG_SCOPE = "AuditLog.Read.All"
# Optional per-user authentication-methods read. Lets the app read
# /users/{upn}/authentication/methods (the same data the Entra "Authentication
# methods" blade shows) to decide MFA registered Yes/No WITHOUT the tenant-wide
# report role. Reading another user's methods also requires the SIGNED-IN user to
# hold an auth-admin/reader role (e.g. Authentication Administrator) — so only that
# person can run the populate; the result is stored in the list for everyone.
AUTHMETHOD_SCOPE = "UserAuthenticationMethod.Read.All"
# Optional user-directory read. Reads each user's department/office/city (the same
# 'Department' shown in the Intune/Entra user properties) so the Software inventory
# can group + filter by department per site. Just an app scope + admin consent — NO
# special directory role (unlike the MFA report). Dormant until consented.
USER_READ_SCOPE = "User.Read.All"
# Registered method types that DON'T count as MFA (password + SSPR-only methods).
_NON_MFA_METHODS = {
    "#microsoft.graph.passwordauthenticationmethod",
    "#microsoft.graph.emailauthenticationmethod",
    "#microsoft.graph.securityquestionauthenticationmethod",
}
# config.json and the token cache are user-editable/per-machine, so they live
# next to the .exe when frozen (not in PyInstaller's temp unpack dir).
if getattr(sys, "frozen", False):
    HERE = os.path.dirname(sys.executable)
else:
    HERE = os.path.dirname(os.path.abspath(__file__))

# The token cache must live somewhere the signed-in user can always write, even
# when the app is installed read-only under C:\Program Files. Keep it per-user in
# LOCALAPPDATA (this also means each user's tokens stay on their own machine and
# never end up in a shared/synced folder next to the exe).
import paths
_USER_DIR = paths.user_dir()
try:
    os.makedirs(_USER_DIR, exist_ok=True)
except Exception:
    _USER_DIR = HERE  # fallback: behave as before
_TOKEN_CACHE = os.path.join(_USER_DIR, ".token_cache.bin")
_INTUNE_SELECT = (
    "id,serialNumber,manufacturer,model,deviceName,userPrincipalName,"
    "userDisplayName,osVersion,operatingSystem,enrolledDateTime,lastSyncDateTime,"
    "totalStorageSpaceInBytes,azureADDeviceId,complianceState"
)


class GraphError(Exception):
    """Graph/HTTP error with a human-readable message."""


def load_config(path: str | None = None) -> dict:
    path = path or os.path.join(HERE, "config.json")
    if not os.path.exists(path):
        raise GraphError(
            "Missing config.json - copy config.example.json to config.json and "
            "fill in tenant_id + client_id."
        )
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    for key in ("tenant_id", "client_id"):
        if not cfg.get(key) or str(cfg[key]).startswith("PASTE"):
            raise GraphError(f"config.json: '{key}' is not filled in yet.")
    return cfg


def _bytes_to_gb(value) -> str:
    try:
        gb = round(int(value) / (1024 ** 3))
        return f"{gb} GB" if gb else ""
    except (TypeError, ValueError):
        return ""


class GraphClient:
    def __init__(self, config: dict | None = None):
        self.cfg = config or load_config()
        import divisions
        self._div_mod = divisions
        self._base_cfg = dict(self.cfg)
        self.registry = divisions.load_registry(self._base_cfg)
        self.division = divisions.find(self.registry, divisions.load_selection())
        self._use_legacy = False     # True only while snapshotting the pre-central (source) site
        self._apply_division()
        import localstore
        self._localstore_mod = localstore
        self.data_mode = localstore.load_mode()      # "live" | "local" (snapshot sandbox)
        self._store = None
        self._force_live = False                     # True only while pulling a snapshot
        self._token: str | None = None
        self._token_exp: float = 0.0         # unix expiry of the in-memory access token
        self._sign_lock = threading.Lock()   # serialize token refresh across threads
        self._app: msal.PublicClientApplication | None = None
        self._site_id: str | None = None
        self._list_ids: dict[str, str] = {}
        self._col_maps: dict[str, dict[str, str]] = {}
        self._resolved: dict[str, dict[str, str | None]] = {}
        self.account_name: str | None = None
        self.account_upn: str = ""
        self._master_cache: dict | None = None
        self._master_at = 0.0
        self._has_dir_read = False           # did the token include Directory.Read.All?
        self._has_auditlog_read = False      # did the token include AuditLog.Read.All?
        self._has_authmethod_read = False    # did the token include UserAuthenticationMethod.Read.All?
        self._has_user_read = False          # did the token include User.Read.All?
        self._dept_cache = {}                # upn_lower -> {department, office, city, ou}
        self._mfa_cache: dict | None = None  # {upn_lower: {"registered": bool, "capable": bool}}
        self._mfa_cache_at = 0.0             # monotonic time of the last MFA report pull
        self._devmap_cache: dict | None = None  # {SERIAL: {..intune fields..}} bulk device map
        self._devmap_at = 0.0                # monotonic time of the last device-map pull
        self._loc_cache: dict[str, dict] = {}  # UPN(lower)/dev id -> {..}, to avoid re-querying

    # ---- division (tenant) ------------------------------------------------
    def _apply_division(self) -> None:
        """Overlay the active division on the base config so every existing
        `self.cfg.get(...)` reads that division's site, lists, category, AD, SQL."""
        d = self.division
        cfg = dict(self._base_cfg)
        central = cfg.get("central") or {}
        self._central = bool(central.get("site_path")) and not self._use_legacy
        cfg.update({"sharepoint_hostname": d.get("sharepoint_hostname") or cfg.get("sharepoint_hostname"),
                    "site_path": d.get("site_path") or cfg.get("site_path"),
                    "lists": d.get("lists") or cfg.get("lists") or {},
                    "intune_device_category": d.get("intune_category") or cfg.get("intune_device_category"),
                    "ad_domain": d.get("ad_domain") or cfg.get("ad_domain"),
                    "timesheet_sql_server": d.get("sql_server") or cfg.get("timesheet_sql_server")})
        if self._central:     # all divisions share the central site + lists
            cfg["sharepoint_hostname"] = central.get("site_host") or cfg.get("sharepoint_hostname")
            cfg["site_path"] = central["site_path"]
            cfg["lists"] = {**DEFAULT_CENTRAL_LISTS, **(central.get("lists") or {})}
        self.cfg = cfg

    def _div_scoped(self, key: str) -> bool:
        """True when rows of this list are shared by all divisions (central live mode)."""
        return self._central and not self._local and key in _DIVISION_SCOPED

    def _item_division(self, item: dict, key: str) -> str:
        col = self._internal_for(key, "division") or "Division"
        return str((item.get("fields", {}) or {}).get(col) or "").strip().lower()

    def _only_division(self, items: list, key: str) -> list:
        if not self._div_scoped(key):
            return items
        me = self.division["id"].lower()
        return [i for i in items if self._item_division(i, key) == me]

    # ---- master settings (super admin, above divisions) ---------------------
    # Stored in the central 'Master Settings' list (Title=key, Value, Secret, Description).
    # SharePoint permissions make the list read-only for everyone but the Owners. config.json
    # remains the fallback so nothing breaks before/while a setting is moved. NOTE: anyone who
    # can run the app can read a secret here (the app has to use it); this centralises and
    # controls EDITING, it does not hide the value from app users.
    _MASTER_TTL = 300.0

    def _master_col(self, display: str) -> str:
        return self._col_map("master_settings").get(display.lower(), display.replace(" ", ""))

    def master_settings(self, force: bool = False) -> dict:
        """key -> {id, value, secret, description}. Empty when not central / local mode / unreadable."""
        import time as _t
        if not self._central or self._local:
            return {}
        if not force and self._master_cache is not None and _t.monotonic() - self._master_at < self._MASTER_TTL:
            return self._master_cache
        out = {}
        try:
            vcol = self._master_col("Value")
            scol = self._master_col("Secret")
            dcol = self._master_col("Description")
            for it in self._items_raw("master_settings"):
                f = it.get("fields", {}) or {}
                k = str(f.get("Title") or "").strip()
                if k and not k.upper().startswith("EXAMPLE"):
                    out[k] = {"id": it.get("id"), "value": str(f.get(vcol) or ""),
                              "secret": str(f.get(scol) or "").strip().lower() in ("yes", "true", "1"),
                              "description": str(f.get(dcol) or "")}
        except Exception:
            out = self._master_cache or {}      # keep last good value; never break callers
        self._master_cache, self._master_at = out, _t.monotonic()
        return out

    def get_setting(self, key: str, default: str = "") -> str:
        """Master setting first, then config.json, then default."""
        v = (self.master_settings().get(key) or {}).get("value", "")
        if v:
            return v
        base = self._base_cfg.get(key)
        return str(base) if base not in (None, "") else default

    def is_super_admin(self) -> bool:
        me = (self.account_upn or "").strip().lower()
        if not me:
            return False
        admins = {a.strip().lower() for a in (self._base_cfg.get("super_admins") or []) if isinstance(a, str)}
        raw = (self.master_settings().get("super_admins") or {}).get("value", "")
        admins |= {a.strip().lower() for a in raw.replace(";", ",").split(",") if a.strip()}
        return me in admins

    def set_setting(self, key: str, value: str, secret: bool | None = None, description: str | None = None) -> None:
        """Create/update one master setting. Super admins only; SharePoint enforces the same."""
        if not self._central:
            raise GraphError("Master settings need the central site (config.json 'central').")
        if self._local:
            raise GraphError("Local data mode: switch to Live to change master settings.")
        if not self.is_super_admin():
            raise GraphError("Only a super admin can change master settings.")
        key = (key or "").strip()
        if not key:
            raise GraphError("Setting key is required.")
        cur = self.master_settings(force=True).get(key)
        vals = {self._master_col("Value"): value}
        if secret is not None:
            vals[self._master_col("Secret")] = "Yes" if secret else "No"
        if description is not None:
            vals[self._master_col("Description")] = description
        site = self._ensure_site()
        lid = self._list_id("master_settings")
        if cur:
            self._req("PATCH", f"{GRAPH}/sites/{site}/lists/{lid}/items/{cur['id']}/fields", json=vals)
        else:
            self._req("POST", f"{GRAPH}/sites/{site}/lists/{lid}/items", json={"fields": {"Title": key, **vals}})
        self._master_cache = None
        self.add_log("Setting changed", key, "", actor=self.account_name or "", details="master setting updated")

    # ---- local data mode (snapshot sandbox) ---------------------------------
    @property
    def _local(self) -> bool:
        return self.data_mode == "local" and not self._force_live

    def _ls(self):
        if self._store is None:
            self._store = self._localstore_mod.LocalStore(self.division["id"])
        return self._store

    def _reset_caches(self) -> None:
        self._site_id = None
        self._list_ids = {}
        self._col_maps = {}
        self._resolved = {}
        self._dept_cache = {}
        self._mfa_cache = None
        self._mfa_cache_at = 0.0
        self._devmap_cache = None
        self._devmap_at = 0.0
        self._loc_cache = {}

    def set_data_mode(self, mode: str) -> str:
        if mode == "local" and not self._ls().has_snapshot():
            raise GraphError("No local snapshot yet - pull production data first.")
        self.data_mode = "local" if mode == "local" else "live"
        self._localstore_mod.save_mode(self.data_mode)
        self._reset_caches()
        return self.data_mode

    def snapshot_hub(self) -> dict:
        """Copy ONLY the division's hub folder (JSON files) into the local sandbox. No SharePoint
        or Graph access needed. Source = the folder Hub() resolves to (script mode: the project SystemsData folder)."""
        import shutil
        from hub import Hub
        src = Hub(division=self.division).logs
        dst = self._localstore_mod.hub_logs_dir(self.division["id"])
        n = 0
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True, ignore=shutil.ignore_patterns("*.tmp", "~*"))
            n = sum(len(f) for _, _, f in os.walk(dst))
        return {"source": src, "dest": dst, "files": n}

    def snapshot_prod(self) -> dict:
        """READ-ONLY pull of production into the local store: the division's SharePoint
        lists (rows + column map) and a copy of its hub folder. Nothing is written to prod."""
        import shutil
        from hub import Hub
        self._force_live = True
        self._use_legacy = True
        self._apply_division()
        try:
            self._reset_caches()
            store = self._ls()
            counts = {}
            for key in ("new_stock", "in_use", "model_specs"):
                try:
                    items = self._items_raw(key)
                    colmap = dict(self._col_map(key))
                except Exception as e:
                    if key == "model_specs":
                        continue          # optional list
                    raise GraphError(f"Snapshot failed on '{key}': {e}")
                store.replace_list(key, colmap, items)
                counts[key] = len(items)
            try:
                lid = self._ensure_log_list()
                site = self._ensure_site()
                logs = self._get_all(f"{GRAPH}/sites/{site}/lists/{lid}/items?expand=fields&$top=200")
                store.replace_list("log", {}, logs)
                counts["log"] = len(logs)
            except Exception:
                pass                      # log list missing/unreadable: skip
            src = Hub(division=self.division)          # live hub folder (read)
            dst = self._localstore_mod.hub_logs_dir(self.division["id"])
            if os.path.isdir(src.logs):
                shutil.copytree(src.logs, dst, dirs_exist_ok=True,
                                ignore=shutil.ignore_patterns("*.tmp", "~*"))
            store.mark_snapshot(self.account_name or "")
            return {"counts": counts, **store.info()}
        finally:
            self._force_live = False
            self._use_legacy = False
            self._apply_division()
            self._reset_caches()

    def _create_item(self, key: str, fields: dict) -> None:
        if self._local:
            self._ls().add(key, fields)
            return
        site = self._ensure_site()
        lid = self._ensure_log_list() if key == "log" else self._list_id(key)
        if self._div_scoped(key):
            fields = dict(fields)
            fields[self._internal_for(key, "division") or "Division"] = self.division["id"]
        self._req("POST", f"{GRAPH}/sites/{site}/lists/{lid}/items", json={"fields": fields})

    def set_division(self, div_id: str) -> dict:
        """Switch tenant. Keeps the sign-in (same user/tenant); drops every cache that
        is specific to the previous division's site, lists, and devices."""
        self.division = self._div_mod.find(self.registry, div_id)
        self._apply_division()
        self._store = None
        self._site_id = None
        self._list_ids = {}
        self._col_maps = {}
        self._resolved = {}
        self._dept_cache = {}
        self._mfa_cache = None
        self._mfa_cache_at = 0.0
        self._devmap_cache = None
        self._devmap_at = 0.0
        self._loc_cache = {}
        self._div_mod.save_selection(self.division["id"])
        return self.division

    # ---- auth -------------------------------------------------------------
    def _cache(self) -> msal.SerializableTokenCache:
        # Local file cache. Production hardening: back this with Windows DPAPI
        # via msal-extensions (PersistedTokenCache). File cache is adequate for
        # a single-user machine and keeps the dependency footprint small.
        cache = msal.SerializableTokenCache()
        p = _TOKEN_CACHE
        if os.path.exists(p):
            cache.deserialize(open(p, encoding="utf-8").read())
        self._cache_path = p
        self._cache_obj = cache
        return cache

    def _save_cache(self) -> None:
        if getattr(self, "_cache_obj", None) and self._cache_obj.has_state_changed:
            open(self._cache_path, "w", encoding="utf-8").write(self._cache_obj.serialize())

    def sign_in(self, interactive: bool = True) -> str:
        # Reuse the in-memory access token only while it's still valid (5-minute
        # safety buffer). Once it nears expiry we fall through and let MSAL
        # silently refresh it from the cached refresh token. Without this a
        # long-open app keeps handing out a stale token and every Graph call
        # 401s -> the dashboard shows the "Sign in" overlay again, and clicking
        # it did nothing because this method returned the same stale token.
        if self._token and time.time() < (self._token_exp - 300):
            return self._token
        # Serialize refresh: the app fires many Graph calls concurrently at launch,
        # and MSAL + the file token cache are NOT thread-safe. Without this lock the
        # threads stampede acquire_token_silent + cache writes at once, which can hang
        # the whole startup (dashboard stuck on "Loading…"). Double-check inside the
        # lock so only the first thread refreshes; the rest reuse the fresh token.
        with self._sign_lock:
            if self._token and time.time() < (self._token_exp - 300):
                return self._token
            return self._acquire(interactive)

    def _acquire(self, interactive: bool) -> str:
        cache = self._cache()
        self._app = msal.PublicClientApplication(
            self.cfg["client_id"],
            authority=f"https://login.microsoftonline.com/{self.cfg['tenant_id']}",
            token_cache=cache,
        )
        result = None
        accounts = self._app.get_accounts()
        full = SCOPES + [DIR_SCOPE, AUDITLOG_SCOPE, AUTHMETHOD_SCOPE, USER_READ_SCOPE]   # + dir read + audit log (MFA report) + auth methods + user dept read
        if accounts:
            result = (self._app.acquire_token_silent(full, account=accounts[0])
                      or self._app.acquire_token_silent(SCOPES, account=accounts[0]))
        if (not result or "access_token" not in result) and interactive:
            # Request the FULL scope set on interactive sign-in. Once an admin has
            # consented these tenant-wide, this returns them with no user prompt AND
            # mints a refresh token authorized for them, so later silent 'full' keeps
            # working. Fall back to core scopes if the full request can't complete
            # (e.g. a scope isn't consented yet) so sign-in never breaks.
            result = self._app.acquire_token_interactive(full)
            if not result or "access_token" not in result:
                result = self._app.acquire_token_interactive(SCOPES)
        self._save_cache()
        if not result or "access_token" not in result:
            err = (result or {}).get("error_description", "no cached account; sign in required")
            raise GraphError(f"Sign-in failed: {err}")
        self._token = result["access_token"]
        # Which scopes we actually got. MSAL's result['scope'] can be stale/empty when a
        # cached token is returned, so read the authoritative 'scp' claim from the token
        # itself (fall back to result['scope']).
        _granted = (result.get("scope") or "").lower()
        # Default expiry from expires_in; overridden by the token's own exp below.
        self._token_exp = time.time() + int(result.get("expires_in", 3600) or 3600)
        try:
            _payload = self._token.split(".")[1]
            _payload += "=" * (-len(_payload) % 4)
            _claims = json.loads(base64.urlsafe_b64decode(_payload))
            _scp = (_claims.get("scp") or "").lower()
            if _scp:
                _granted = _scp
            if _claims.get("exp"):
                self._token_exp = float(_claims["exp"])
        except Exception:
            pass
        self._has_dir_read = "directory.read.all" in _granted
        self._has_auditlog_read = "auditlog.read.all" in _granted
        self._has_authmethod_read = "userauthenticationmethod.read.all" in _granted
        self._has_user_read = "user.read.all" in _granted
        self.account_name = (result.get("id_token_claims") or {}).get("name") or (
            accounts[0]["username"] if accounts else None
        )
        self.account_upn = ((result.get("id_token_claims") or {}).get("preferred_username")
                            or (accounts[0]["username"] if accounts else "") or "")
        return self._token

    def sign_out(self) -> None:
        if self._app:
            for acc in self._app.get_accounts():
                self._app.remove_account(acc)
        self._token = None
        try:
            os.remove(_TOKEN_CACHE)
        except OSError:
            pass

    # ---- low-level HTTP ---------------------------------------------------
    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.sign_in(interactive=False)}"}

    def _req(self, method: str, url: str, **kwargs) -> requests.Response:
        extra = kwargs.pop("headers", {})
        r = None
        for attempt in range(4):
            r = requests.request(method, url, headers={**self._headers(), **extra},
                                 timeout=30, **kwargs)
            if r.ok:
                return r
            # A 401 mid-session usually means the access token expired. Drop it so
            # _headers() forces a silent refresh from the cached refresh token,
            # then retry. (managedDevices 401s are a missing-role case handled below.)
            if (r.status_code == 401 and attempt < 3 and "managedDevices" not in url):
                self._token = None
                self._token_exp = 0.0
                continue
            # Graph/SharePoint throttle bulk writes with 429 (or transient 503). Honor
            # Retry-After and retry a few times so a large first sync completes.
            if r.status_code in (429, 503) and attempt < 3:
                try:
                    wait = int(r.headers.get("Retry-After", "5") or "5")
                except ValueError:
                    wait = 5
                time.sleep(min(max(wait, 1), 30))
                continue
            break
        body = r.text or ""
        # Intune denies device reads with 401/403 and a nested "Forbidden" body when the
        # signed-in user lacks an Intune RBAC role — surface a clear, actionable message.
        if "managedDevices" in url and (r.status_code in (401, 403) or "Forbidden" in body):
            raise GraphError(
                "Intune denied access to managed devices. Two things to check: "
                "(1) if you granted admin consent recently, click Sign out and sign in again "
                "to refresh your token; (2) your account needs an Intune role with "
                "'Managed devices: Read' (e.g. Help Desk Operator) scoped to all devices — "
                "ask an Intune admin to assign it."
            )
        if r.status_code == 403:
            raise GraphError(
                f"403 Forbidden on {url.split('?')[0]} - your account lacks permission "
                "(for SharePoint this means no Contribute on the list)."
            )
        raise GraphError(f"{method} {url.split('?')[0]} -> {r.status_code}: {body[:300]}")

    def _get(self, url: str) -> dict:
        return self._req("GET", url).json()

    def _get_all(self, url: str) -> list[dict]:
        """Follow @odata.nextLink pagination and return all items."""
        out: list[dict] = []
        while url:
            data = self._get(url)
            out.extend(data.get("value", []))
            url = data.get("@odata.nextLink")
        return out

    # ---- site + list resolution ------------------------------------------
    def _ensure_site(self) -> str:
        if self._local:
            return "local"
        if self._site_id:
            return self._site_id
        host = self.cfg.get("sharepoint_hostname", "nucor.sharepoint.com")
        spath = self.cfg.get("site_path", "/sites/NBGW/systems")
        data = self._get(f"{GRAPH}/sites/{host}:{spath}")
        self._site_id = data["id"]
        self._site_name = data.get("displayName") or data.get("name") or spath
        self._site_web = data.get("webUrl") or ""
        return self._site_id

    def _list_id(self, key: str) -> str:
        if self._local:
            return "local:" + key
        if key in self._list_ids:
            return self._list_ids[key]
        site = self._ensure_site()
        want = self.cfg["lists"][key]
        wl = want.strip().lower()
        lists = self._get_all(f"{GRAPH}/sites/{site}/lists?$select=id,name,displayName")
        for l in lists:
            names = [(l.get("displayName") or "").strip().lower(), (l.get("name") or "").strip().lower()]
            if wl in names:
                self._list_ids[key] = l["id"]
                return l["id"]
        available = ", ".join(sorted(l.get("displayName") or l.get("name") or "?" for l in lists)) or "(none)"
        site_name = getattr(self, "_site_name", "?")
        site_web = getattr(self, "_site_web", "")
        raise GraphError(
            f"List '{want}' not found. Resolved site: '{site_name}' ({site_web}). "
            f"Lists on this site: {available}"
        )

    def _col_map(self, key: str) -> dict[str, str]:
        """displayName(lower) -> internal name, for the given list."""
        if key in self._col_maps:
            return self._col_maps[key]
        if self._local:
            self._col_maps[key] = self._ls().colmap(key)
            return self._col_maps[key]
        site = self._ensure_site()
        cols = self._get_all(
            f"{GRAPH}/sites/{site}/lists/{self._list_id(key)}/columns?$select=name,displayName"
        )
        m = {}
        for c in cols:
            if c.get("displayName"):
                m[c["displayName"].strip().lower()] = c["name"]
            if c.get("name"):
                m.setdefault(c["name"].strip().lower(), c["name"])
        self._col_maps[key] = m
        return m

    def _internal_for(self, key: str, logical: str) -> str | None:
        """Resolve our logical field name to the list's real internal column name,
        via FIELD_ALIASES against the actual columns. Cached per list."""
        cache = self._resolved.setdefault(key, {})
        if logical in cache:
            return cache[logical]
        cmap = self._col_map(key)  # displayName.lower + name.lower -> internal
        aliases = FIELD_ALIASES.get(logical, [logical])
        internal = None
        for a in aliases:                      # exact match first
            if a in cmap:
                internal = cmap[a]
                break
        if not internal:                       # then substring match on display names
            for disp, intern in cmap.items():
                if any(a in disp for a in aliases):
                    internal = intern
                    break
        cache[logical] = internal
        return internal

    def _fields_for(self, key: str, logical_values: dict) -> dict:
        """Build a Graph {fields} payload from logical field -> value."""
        out = {}
        for logical, val in logical_values.items():
            if val is None or val == "":
                continue
            if logical == "serial":
                out["Title"] = val
                continue
            internal = self._internal_for(key, logical)
            if internal:
                out[internal] = val
        return out

    # ---- Intune -----------------------------------------------------------
    def lookup_intune(self, serial: str) -> dict | None:
        serial = serial.strip().replace("'", "''")
        url = (f"{GRAPH}/deviceManagement/managedDevices"
               f"?$filter=serialNumber eq '{serial}'&$select={_INTUNE_SELECT}")
        hits = self._get(url).get("value", [])
        if not hits:
            return None
        d = hits[0]
        return {
            "serial": d.get("serialNumber", ""),
            "manufacturer": d.get("manufacturer", ""),
            "model": d.get("model", ""),
            "device_name": d.get("deviceName", ""),
            "user": d.get("userPrincipalName") or "",
            "user_display": d.get("userDisplayName") or "",
            "os_version": d.get("osVersion") or "",
            "os": d.get("operatingSystem") or "",
            "enrolled": d.get("enrolledDateTime") or "",
            # Intune has no true OS-install date; enrolledDateTime is the standard proxy.
            "os_install": d.get("enrolledDateTime") or "",
            "last_checkin": d.get("lastSyncDateTime") or "",
            "storage": _bytes_to_gb(d.get("totalStorageSpaceInBytes")),
            "aad_device_id": d.get("azureADDeviceId") or "",
            "compliance": d.get("complianceState") or "",
        }

    def intune_lastsync_map(self) -> dict:
        """One bulk call: {SERIAL(upper): lastSyncDateTime} for every managed device.
        Cheap (paginated) way to refresh 'last check-in' without per-serial lookups."""
        out = {}
        url = f"{GRAPH}/deviceManagement/managedDevices?$select=serialNumber,lastSyncDateTime&$top=1000"
        for d in self._get_all(url):
            s = (d.get("serialNumber") or "").strip().upper()
            if s:
                out[s] = d.get("lastSyncDateTime") or ""
        return out

    def intune_device_map(self, ttl: float = 120.0) -> dict:
        """One bulk paged call: {SERIAL(upper): {..device fields incl. complianceState..}}
        for the NBGW fleet. Lets us enrich a handful of records (hot spares) without a
        filtered call per serial. Cached in-process for `ttl` seconds so a polling
        dashboard doesn't re-pull the fleet every refresh.

        IMPORTANT: filtered server-side to the configured device CATEGORY (default
        'NBGW') — never pull the whole tenant, which on a large org is huge and would
        hang the dashboard."""
        if self._devmap_cache is not None and (time.monotonic() - self._devmap_at) < ttl:
            return self._devmap_cache
        out = {}
        category = (self.cfg.get("intune_device_category") or "NBGW").strip().replace("'", "''")
        url = (f"{GRAPH}/deviceManagement/managedDevices"
               f"?$filter=deviceCategoryDisplayName eq '{category}'&$select={_INTUNE_SELECT}&$top=200")
        for d in self._get_all(url):
            s = (d.get("serialNumber") or "").strip().upper()
            if not s:
                continue
            out[s] = {
                "serial": d.get("serialNumber", ""),
                "manufacturer": d.get("manufacturer", ""),
                "model": d.get("model", ""),
                "device_name": d.get("deviceName", ""),
                "user": d.get("userPrincipalName") or "",
                "os_version": d.get("osVersion") or "",
                "os_install": d.get("enrolledDateTime") or "",
                "last_checkin": d.get("lastSyncDateTime") or "",
                "storage": _bytes_to_gb(d.get("totalStorageSpaceInBytes")),
                "compliance": d.get("complianceState") or "",
            }
        self._devmap_cache = out
        self._devmap_at = time.monotonic()
        return out

    def intune_presence_map(self, serials) -> dict:
        """{SERIAL(upper): lastSyncDateTime} for the given serials, across ALL Intune
        managed devices (ANY category) via $batch — answers 'is this device still in
        Intune?' for the locate/troubleshoot view, without pulling the whole fleet and
        without the NBGW-category narrowing that intune_device_map applies."""
        vals = sorted({(s or "").strip() for s in (serials or []) if (s or "").strip()})
        if not vals:
            return {}
        out = {}
        for i in range(0, len(vals), 20):
            chunk = vals[i:i + 20]
            reqs = [{"id": str(j), "method": "GET",
                     "url": (f"/deviceManagement/managedDevices"
                             f"?$filter=serialNumber eq '{s.replace(chr(39), chr(39) * 2)}'"
                             "&$select=serialNumber,lastSyncDateTime")}
                    for j, s in enumerate(chunk)]
            try:
                resp = self._req("POST", f"{GRAPH}/$batch", json={"requests": reqs}).json()
            except GraphError:
                return out
            for r in resp.get("responses", []):
                if r.get("status") != 200:
                    continue
                for d in (((r.get("body") or {}).get("value")) or []):
                    s = (d.get("serialNumber") or "").strip().upper()
                    if s:
                        out[s] = d.get("lastSyncDateTime") or ""
        return out

    def entra_device_map(self, hostnames) -> dict:
        """{hostname_lower: {enabled, last_signin, trust}} for the given hostnames,
        from Entra (/devices, matched on displayName). Batched via $batch (20 per
        request). Returns {} when Directory.Read.All isn't granted (the Entra column
        then shows as dormant rather than falsely 'not found')."""
        names = sorted({(h or "").strip() for h in (hostnames or []) if (h or "").strip()})
        if not names or not self._has_dir_read:
            return {}
        select = "displayName,accountEnabled,approximateLastSignInDateTime,trustType"
        out = {}
        for i in range(0, len(names), 20):
            chunk = names[i:i + 20]
            reqs = [{"id": str(j), "method": "GET",
                     "url": f"/devices?$filter=displayName eq '{nm.replace(chr(39), chr(39) * 2)}'&$select={select}"}
                    for j, nm in enumerate(chunk)]
            try:
                resp = self._req("POST", f"{GRAPH}/$batch", json={"requests": reqs}).json()
            except GraphError:
                self._has_dir_read = False   # consent revoked mid-run; stop trying
                return out
            for r in resp.get("responses", []):
                if r.get("status") != 200:
                    continue
                vals = ((r.get("body") or {}).get("value")) or []
                if not vals:
                    continue
                d = vals[0]
                dn = (d.get("displayName") or "").strip().lower()
                if dn:
                    out[dn] = {"enabled": bool(d.get("accountEnabled")),
                               "last_signin": (d.get("approximateLastSignInDateTime") or "")[:10],
                               "trust": d.get("trustType") or ""}
        return out

    def groups_for_users(self, user_ids, keyword: str = "") -> dict:
        """{user_id: [group displayNames]} for each user's transitive (direct + nested)
        group membership, batched 20 per $batch request. If `keyword` is given, only
        groups whose name contains it (case-insensitive) are returned; empty keyword
        returns ALL groups — used to build per-department group baselines efficiently.
        Requires Directory.Read.All."""
        ids = [u for u in (user_ids or []) if u]
        if not ids or not self._has_dir_read:
            return {}
        kw = (keyword or "").strip().lower()
        out: dict[str, list] = {}
        sub = ("/transitiveMemberOf/microsoft.graph.group?$select=displayName,id&$top=999")
        for i in range(0, len(ids), 20):
            chunk = ids[i:i + 20]
            reqs = [{"id": str(j), "method": "GET", "url": f"/users/{uid}{sub}"}
                    for j, uid in enumerate(chunk)]
            try:
                resp = self._req("POST", f"{GRAPH}/$batch", json={"requests": reqs}).json()
            except GraphError:
                self._has_dir_read = False
                return out
            for r in resp.get("responses", []):
                try:
                    idx = int(r.get("id"))
                except (TypeError, ValueError):
                    continue
                uid = chunk[idx] if 0 <= idx < len(chunk) else None
                if uid is None or r.get("status") != 200:
                    continue
                body = r.get("body") or {}
                vals = body.get("value") or []
                # A user in >999 groups would paginate; batch drops the nextLink, so
                # fall back to a full paged fetch for that (rare) user.
                if body.get("@odata.nextLink"):
                    vals = self._get_all(f"{GRAPH}/users/{uid}{sub}")
                names = []
                for g in vals:
                    nm = g.get("displayName") or ""
                    if nm and (not kw or kw in nm.lower()):
                        names.append(nm)
                out[uid] = sorted(set(names), key=str.lower)
        return out

    def mfa_registration_map(self, ttl: float = 1800.0) -> dict:
        """{upn_lower: {"registered": bool, "capable": bool}} for every user in the
        tenant, from the authentication-methods registration report. One bulk paged
        call, cached in-process for `ttl` seconds (default 30 min) so repeated
        dashboard/table loads reuse it.

        Needs AuditLog.Read.All AND a directory role that can read the report
        (Reports/Security Reader, Security Admin, Global Reader). Returns {} — never
        raises — when the scope isn't granted or the read is refused, so the MFA
        column simply stays blank until an admin consents.
        """
        if not self._has_auditlog_read:
            return {}
        if self._mfa_cache is not None and (time.monotonic() - self._mfa_cache_at) < ttl:
            return self._mfa_cache
        out: dict = {}
        url = f"{GRAPH}/reports/authenticationMethods/userRegistrationDetails?$top=500"
        try:
            for d in self._get_all(url):
                upn = (d.get("userPrincipalName") or "").strip().lower()
                if upn:
                    out[upn] = {"registered": bool(d.get("isMfaRegistered")),
                                "capable": bool(d.get("isMfaCapable"))}
        except GraphError:
            self._has_auditlog_read = False   # scope/role not actually available; stop trying
            return {}
        self._mfa_cache = out
        self._mfa_cache_at = time.monotonic()
        return out

    def mfa_for_user(self, upn: str) -> str | None:
        """'Yes'/'No' whether this user has a strong (non-password/SSPR) auth method
        registered, read per-user from /users/{upn}/authentication/methods — the same
        data the Entra "Authentication methods" blade shows. Needs
        UserAuthenticationMethod.Read.All AND the signed-in caller holding an
        auth-admin/reader role. Returns None (so callers skip) when the scope/role
        isn't available or the user can't be read."""
        upn = (upn or "").strip()
        if not upn or not self._has_authmethod_read:
            return None
        try:
            data = self._get(f"{GRAPH}/users/{quote(upn, safe='@')}/authentication/methods")
        except GraphError:
            # 403 here means the signed-in account lacks the directory role
            # (Global Reader / Authentication Administrator). Stop trying per-user.
            self._has_authmethod_read = False
            return None
        methods = data.get("value", []) if isinstance(data, dict) else []
        strong = any((m.get("@odata.type", "").lower() not in _NON_MFA_METHODS) for m in methods)
        return "Yes" if strong else "No"

    def mfa_status(self, upn: str, mmap: dict | None = None) -> str | None:
        """MFA 'Yes'/'No' for a user: use the bulk report map if we have it,
        otherwise fall back to the per-user authentication-methods read. None when
        neither source is available."""
        u = (upn or "").strip().lower()
        if not u:
            return None
        if mmap:
            info = mmap.get(u)
            if info:
                return "Yes" if info["registered"] else "No"
        return self.mfa_for_user(upn)

    def _user_department(self, upn: str) -> dict:
        """{'department','office','city','ou'} for a user — the same Department shown
        in the Intune/Entra user properties. Needs User.Read.All (or Directory.Read.All);
        returns {} (never raises) until that's consented. Cached per UPN."""
        upn = (upn or "").strip()
        if not upn or not self._has_user_read:
            return {}
        key = upn.lower()
        if key in self._dept_cache:
            return self._dept_cache[key]
        info = {}
        try:
            d = self._get(f"{GRAPH}/users/{quote(upn, safe='@')}"
                          f"?$select=department,officeLocation,city,onPremisesDistinguishedName")
            info = {"department": (d.get("department") or "").strip(),
                    "office": (d.get("officeLocation") or "").strip(),
                    "city": (d.get("city") or "").strip(),
                    "ou": (d.get("onPremisesDistinguishedName") or "").strip()}
        except GraphError:
            self._has_user_read = False   # not actually available; stop trying
            return {}
        self._dept_cache[key] = info
        return info

    def _prefetch_departments(self, upns) -> None:
        """Resolve many users' departments in a few $batch calls (20 per request)
        instead of one call each — used before the software export parse. No-op until
        User.Read.All is consented."""
        if not self._has_user_read:
            return
        todo = [u for u in dict.fromkeys((x or "").strip() for x in upns if (x or "").strip())
                if u.lower() not in self._dept_cache]
        for i in range(0, len(todo), 20):
            chunk = todo[i:i + 20]
            reqs = [{"id": str(j), "method": "GET",
                     "url": f"/users/{quote(u, safe='@')}?$select=department,officeLocation,city,onPremisesDistinguishedName"}
                    for j, u in enumerate(chunk)]
            try:
                r = self._req("POST", f"{GRAPH}/$batch", json={"requests": reqs})
                for resp in (r.json().get("responses") or []):
                    try:
                        idx = int(resp.get("id", "0"))
                    except ValueError:
                        continue
                    if idx >= len(chunk):
                        continue
                    u = chunk[idx]
                    b = resp.get("body") or {}
                    if resp.get("status") == 200:
                        self._dept_cache[u.lower()] = {
                            "department": (b.get("department") or "").strip(),
                            "office": (b.get("officeLocation") or "").strip(),
                            "city": (b.get("city") or "").strip(),
                            "ou": (b.get("onPremisesDistinguishedName") or "").strip()}
                    else:
                        self._dept_cache[u.lower()] = {}
            except Exception:
                break

    def _run_appinv_export(self, poll_seconds: int) -> str:
        """Start the AppInvRawData export and poll to completion; return the download
        URL. Tries a slim column select first, falls back to the full report if the
        select is rejected or the job fails. Raises GraphError if none completes."""
        bodies = (
            {"reportName": "AppInvRawData", "format": "csv",
             "select": ["DeviceName", "DeviceId", "ApplicationName", "ApplicationVersion", "ApplicationPublisher"]},
            {"reportName": "AppInvRawData", "format": "csv"},   # fallback: all columns
        )
        for body in bodies:
            try:
                r = self._req("POST", f"{GRAPH}/deviceManagement/reports/exportJobs", json=body)
                jid = (r.json() or {}).get("id")
            except Exception:
                jid = None
            if not jid:
                continue
            waited = 0
            while waited < poll_seconds:
                jr = self._get(f"{GRAPH}/deviceManagement/reports/exportJobs('{jid}')")
                status = (jr.get("status") or "").lower()
                if status == "completed":
                    return jr.get("url")
                if status == "failed":
                    break            # try the next (fallback) body
                time.sleep(5)
                waited += 5
        raise GraphError("Intune software-inventory export didn't complete — click Refresh again in a moment.")

    def software_inventory(self, poll_seconds: int = 240) -> dict:
        """Fleet software inventory via Intune's BULK EXPORT report (AppInvRawData) —
        one async export + CSV download, so it never hammers /detectedApps (which
        throttles with 429). Filters to NBGW devices, resolves each user's site +
        department (department needs User.Read.All). Returns
        {apps:[{name,version,publisher,count,installs:[{device,serial,user,site,dept}]}],
         users:[{user,site,dept}], devices, generated_at}."""
        # NBGW device map: id -> device row, plus name lookup
        dev_by_id, by_name = {}, {}
        for d in self.get_intune_category_devices():
            did = (d.get("id") or "").strip()
            if did:
                dev_by_id[did] = d
            nm = (d.get("device_name") or "").strip().lower()
            if nm:
                by_name[nm] = d

        # resolve departments for the NBGW users up front (batched) so the parse is fast
        self._prefetch_departments([d.get("user") for d in dev_by_id.values()])

        # 1+2) run the export (per-device app inventory). Try a slim column set first
        # for a small download; if Intune rejects the select or the job fails, retry
        # with the full report so a refresh still succeeds.
        dl = self._run_appinv_export(poll_seconds)
        # 3) download the (zipped) CSV and STREAM-parse it (the export is tenant-wide,
        # so the file can be large — never materialize it all in memory)
        resp = requests.get(dl, timeout=300)
        resp.raise_for_status()
        buf = io.BytesIO(resp.content)

        def pick(row, *names):
            for n in names:
                for k in row:
                    if (k or "").strip().lower() == n.lower():
                        return (row[k] or "").strip()
            return ""

        apps, users = {}, {}

        def consume(reader):
            for row in reader:
                dname = pick(row, "DeviceName")
                did = pick(row, "DeviceId")
                dev = dev_by_id.get(did) or by_name.get(dname.lower())
                if not dev:
                    continue   # not an NBGW device
                an = pick(row, "ApplicationName", "AppName")
                if not an:
                    continue
                av = pick(row, "ApplicationVersion", "AppVersion")
                pub = pick(row, "ApplicationPublisher", "Publisher")
                if "microsoft" in pub.lower():
                    continue   # skip Microsoft-published apps (per request)
                upn = (dev.get("user") or "").strip()
                site = (dev.get("site_tag") or self._site_from_name(dev.get("device_name", ""))).strip()
                dept = ""
                if upn:
                    dept = (self._user_department(upn) or {}).get("department", "")
                    users.setdefault(upn, {"user": upn, "site": site, "dept": dept})
                key = an + "|" + av
                rec = apps.get(key)
                if not rec:
                    rec = {"name": an, "version": av, "publisher": pub, "installs": []}
                    apps[key] = rec
                rec["installs"].append({"device": dev.get("device_name", ""), "serial": dev.get("serial", ""),
                                        "user": upn, "site": site, "dept": dept})

        try:
            zf = zipfile.ZipFile(buf)
            cn = next((n for n in zf.namelist() if n.lower().endswith(".csv")), None)
            if not cn:
                raise GraphError("Software-inventory export had no CSV.")
            with zf.open(cn) as fh:
                consume(csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig", errors="replace")))
        except zipfile.BadZipFile:
            consume(csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig", errors="replace"))))

        out_apps = []
        for rec in apps.values():
            rec["count"] = len(rec["installs"])
            out_apps.append(rec)
        out_apps.sort(key=lambda r: (-r["count"], r["name"].lower()))
        return {"apps": out_apps, "users": list(users.values()),
                "devices": len(dev_by_id),
                "generated_at": _dt.datetime.now().astimezone().isoformat()}

    # ---- Intune: NBGW fleet (populate/refresh In Use) --------------------
    def _site_from_name(self, device_name: str) -> str:
        """Infer the site tag from the device naming convention (division's device prefixes)."""
        return self._div_mod.site_from_name(self.division, device_name)

    def my_location(self) -> dict:
        """The SIGNED-IN user's own city/office. Uses /me — covered by the basic
        User.Read scope the app already has (no elevated consent needed)."""
        try:
            d = self._get(f"{GRAPH}/me?$select=city,officeLocation")
            return {"city": (d.get("city") or "").strip(), "office": (d.get("officeLocation") or "").strip()}
        except Exception:
            return {}

    def _city_to_site(self, city: str) -> str:
        """Map a user's city to a site code (division's city prefixes)."""
        return self._div_mod.city_to_site(self.division, city)

    def _device_owner(self, aad_device_id: str) -> dict | None:
        """For a co-managed/hybrid device whose Intune record has no user, the real
        primary user is the Azure AD device's registered owner. Resolve it (and their
        city/office in the same object) via the Azure AD /devices object. Needs the
        Directory.Read.All scope; returns None otherwise. Cached per device id."""
        if not aad_device_id or not self._has_dir_read:
            return None
        key = "dev:" + aad_device_id
        if key in self._loc_cache:
            return self._loc_cache[key]
        res = None
        try:
            r = requests.get(f"{GRAPH}/devices?$filter=deviceId eq '{aad_device_id}'&$select=id",
                             headers=self._headers(), timeout=20)
            if r.status_code == 403:
                self._has_dir_read = False
                return None
            vals = r.json().get("value", []) if r.ok else []
            if vals:
                oid = vals[0]["id"]
                for rel in ("registeredOwners", "registeredUsers"):
                    rr = requests.get(f"{GRAPH}/devices/{oid}/{rel}?$select=userPrincipalName,city,officeLocation",
                                      headers=self._headers(), timeout=20)
                    if rr.ok:
                        owners = [o for o in rr.json().get("value", []) if o.get("userPrincipalName")]
                        if owners:
                            o = owners[0]
                            res = {"upn": (o.get("userPrincipalName") or "").strip(),
                                   "city": (o.get("city") or "").strip(),
                                   "office": (o.get("officeLocation") or "").strip()}
                            break
        except Exception:
            res = None
        self._loc_cache[key] = res
        return res

    def _user_location(self, upn: str) -> dict | None:
        """The primary user's `city` + `officeLocation` from their Entra profile, used
        to resolve a blank site (city -> LTR/BRI) and, for users outside NBGW, to show
        where they are (office location). Needs the Directory.Read.All scope (see
        DIR_SCOPE); returns None if that read isn't available. Cached per UPN."""
        if not upn or not self._has_dir_read:
            return None
        key = upn.strip().lower()
        if key in self._loc_cache:
            return self._loc_cache[key]
        loc = {"city": "", "office": ""}
        try:
            from urllib.parse import quote
            r = requests.get(f"{GRAPH}/users/{quote(upn.strip())}?$select=city,officeLocation",
                             headers=self._headers(), timeout=20)
            if r.status_code == 403:
                self._has_dir_read = False   # scope not actually granted; stop trying
                return None
            elif r.ok:
                d = r.json()
                loc = {"city": (d.get("city") or "").strip(),
                       "office": (d.get("officeLocation") or "").strip()}
        except Exception:
            pass
        self._loc_cache[key] = loc
        return loc

    def get_intune_category_devices(self) -> list[dict]:
        """Intune managed devices in the configured **device category** (default
        'NBGW'), mapped to In Use row dicts.

        Filtered server-side on deviceCategoryDisplayName (confirmed supported).
        By default only computers are returned (operatingSystem = Windows); set
        `intune_device_os` in config.json to "all" (or "" ) to include every device
        type (phones/tablets) in a later phase - or to another OS to target that.
        """
        category = (self.cfg.get("intune_device_category") or "NBGW").strip().replace("'", "''")
        os_want = (self.cfg.get("intune_device_os", "Windows") or "").strip().lower()
        include_all_os = os_want in ("", "all", "*", "any")
        select = _INTUNE_SELECT + ",deviceCategoryDisplayName"
        url = (f"{GRAPH}/deviceManagement/managedDevices"
               f"?$filter=deviceCategoryDisplayName eq '{category}'&$select={select}&$top=200")
        devices = self._get_all(url)
        rows = []
        for d in devices:
            if not include_all_os:
                if (d.get("operatingSystem") or "").strip().lower() != os_want:
                    continue
            name = d.get("deviceName", "")
            rows.append({
                "id": d.get("id", ""),
                "serial": d.get("serialNumber", ""),
                "device_name": name,
                "manufacturer": d.get("manufacturer", ""),
                "model": d.get("model", ""),
                "user": d.get("userPrincipalName") or "",
                "os_version": d.get("osVersion") or "",
                # Intune has no true OS-install date; enrolledDateTime is the proxy.
                "os_install": d.get("enrolledDateTime") or "",
                "last_checkin": d.get("lastSyncDateTime") or "",
                "storage": _bytes_to_gb(d.get("totalStorageSpaceInBytes")),
                "site_tag": self._site_from_name(name),
                "aad_device_id": d.get("azureADDeviceId") or "",
                "cpu": "", "ram": "", "warranty": "",
            })
        return rows

    # ---- Vendor fallback (device not yet in Intune) ----------------------
    @staticmethod
    def _clean(text: str) -> str:
        """Strip HTML tags and non-ASCII (Lenovo returns latin-1 (R)/(TM) bytes)."""
        return re.sub(r"\s+", " ", re.sub(r"[^\x20-\x7e]", "", re.sub(r"<.*?>", "", text or ""))).strip()

    @classmethod
    def _parse_lenovo_spec(cls, html: str) -> dict:
        """Parse the Lenovo product Specification HTML table -> {cpu, ram, storage}.
        Label matching is fuzzy (substring) because Lenovo varies row labels across
        models (e.g. 'Memory' vs 'System Memory', 'Hard Drive' vs 'Solid State Drive')."""
        pairs = [(cls._clean(l).lower(), cls._clean(v))
                 for l, v in re.findall(r"<tr>\s*<td>(.*?)</td>\s*<td>(.*?)</td>\s*</tr>",
                                        html or "", re.S | re.I)]

        def find(*keys):
            for lbl, val in pairs:
                if any(k in lbl for k in keys):
                    return val
            return ""

        out = {}
        proc = find("processor", "cpu")
        if proc:
            p = re.sub(r"^\s*\d+\s*x\s*", "", proc)          # drop leading "1x "
            p = p.split("(")[0]                               # drop "(Core Ultra 7 258V)"
            p = re.sub(r"\bprocessor\b", "", p, flags=re.I).strip(" -,")
            out["cpu"] = re.sub(r"\s+", " ", p).strip()
        mem = find("memory", "ram")
        if mem:
            # Modules look like "1x 8 GB". Bound the count/size digits so a DDR speed
            # that runs into the next module (e.g. "...DDR4-32001x 8 GB") can't be read
            # as a giant count (that produced "256016 GB"). Count 1-2 digits, size 1-3.
            mods = re.findall(r"(\d{1,2})\s*x\s*(\d{1,3})\s*GB", mem, re.I)
            if mods:
                out["ram"] = f"{sum(int(c) * int(s) for c, s in mods)} GB"
            else:
                m = re.search(r"(\d{1,4})\s*GB", mem, re.I)
                if m:
                    out["ram"] = f"{m.group(1)} GB"
        hd = find("hard drive", "solid state", "ssd", "storage", "drive", "disk", "emmc")
        if hd:
            m = re.search(r"(\d+(?:\.\d+)?)\s*(GB|TB)", hd, re.I)
            if m:
                out["storage"] = f"{m.group(1)} {m.group(2).upper()}"
        return out

    @classmethod
    def _clean_lenovo_model(cls, name: str) -> str:
        n = (name or "").split(" - ")[0]
        n = re.sub(r"\(Type[^)]*\)", "", n)          # drop "(Type 21NS, 21NT)"
        n = re.sub(r"\bLaptop\b", "", n)
        n = re.sub(r"\(([^)]*)\)", r"\1", n)          # unwrap "(ThinkPad)"
        return cls._clean(n)

    def lookup_lenovo(self, serial: str) -> dict | None:
        """Resolve a Lenovo device from its serial via the Lenovo API. Used when
        the device isn't in Intune yet. Pulls model + warranty (warranty endpoint)
        and CPU/RAM/storage (product endpoint's Specification table).
        Returns {model, cpu, ram, storage, warranty_end, machine_type, mtm} or None.
        Never raises.
        """
        key = self.get_setting("lenovo_client_id")
        serial = (serial or "").strip()
        if not key or not serial:
            return None
        h = {"ClientID": key, "Content-Type": "application/x-www-form-urlencoded"}
        res = {"model": "", "cpu": "", "ram": "", "storage": "", "warranty_end": "",
               "machine_type": "", "mtm": ""}
        got = False

        # Warranty endpoint: model path + warranty end date
        try:
            r = requests.post(LENOVO_WARRANTY_URL, headers=h, data=f"Serial={serial}", timeout=20)
            if r.ok:
                d = r.json()
                d = d[0] if isinstance(d, list) and d else d
                parts = [p for p in (d.get("Product") or "").split("/") if p]
                if len(parts) >= 4:
                    res["model"], res["machine_type"], res["mtm"] = parts[-4], parts[-3], parts[-2]
                warns = d.get("Warranty") or []
                if warns:
                    res["warranty_end"] = max((w.get("End", "") for w in warns), default="")[:10]
                got = True
        except Exception:
            pass

        # Product endpoint: friendly model name + CPU/RAM/storage from the spec table
        try:
            r = requests.post(LENOVO_PRODUCT_URL, headers=h, data=f"Serial={serial}", timeout=20)
            if r.ok:
                d = r.json()
                d = d[0] if isinstance(d, list) and d else d
                specs = self._parse_lenovo_spec(d.get("Specification") or "")
                res["cpu"] = specs.get("cpu", "") or res["cpu"]
                res["ram"] = specs.get("ram", "") or res["ram"]
                res["storage"] = specs.get("storage", "") or res["storage"]
                nice = self._clean_lenovo_model(d.get("Name") or "")
                if nice:
                    res["model"] = nice
                got = True
        except Exception:
            pass

        return res if got and (res["model"] or res["mtm"]) else None

    def lookup_dell(self, serial: str) -> dict | None:
        """Placeholder until the Dell TechDirect API key arrives. Wire the real
        endpoint here (service tag -> model/CPU/RAM/storage/warranty) and return the
        same shape as lookup_lenovo: {model, cpu, ram, storage, warranty_end}."""
        return None

    # ---- Model Spec References -------------------------------------------
    def lookup_model_spec(self, model: str) -> dict | None:
        if not model:
            return None
        def scan():
            return [i for i in self._items_raw("model_specs")
                    if (i.get("fields", {}).get("Title") or "").strip().lower() == model.strip().lower()]
        if self._local:
            hits = scan()
        else:
            site = self._ensure_site()
            model_q = model.strip().replace("'", "''")
            url = (f"{GRAPH}/sites/{site}/lists/{self._list_id('model_specs')}/items"
                   f"?expand=fields&$filter=fields/Title eq '{model_q}'")
            try:
                hits = self._get(url).get("value", [])
            except GraphError:
                hits = scan()      # unindexed Title: client-side scan
        if not hits:
            return None
        f = hits[0]["fields"]
        cpu_key = self._internal_for("model_specs", "cpu") or "CPU"
        ram_key = self._internal_for("model_specs", "ram") or "Memory_x0028_RAM_x0029_"
        return {"model": f.get("Title", model), "cpu": f.get(cpu_key, ""), "ram": f.get(ram_key, "")}

    def add_model_spec(self, model: str, cpu: str, ram: str) -> None:
        fields = self._fields_for("model_specs", {"serial": model, "cpu": cpu, "ram": ram})
        fields.setdefault("Title", model)
        self._create_item("model_specs", fields)

    # ---- generic list items ----------------------------------------------
    def _items_raw(self, key: str) -> list[dict]:
        if self._local:
            return self._ls().items(key)
        site = self._ensure_site()
        return self._only_division(self._get_all(
            f"{GRAPH}/sites/{site}/lists/{self._list_id(key)}/items?expand=fields&$top=500"
        ), key)

    def find_by_serial(self, key: str, serial: str) -> dict | None:
        s = serial.strip().lower()
        for it in self._items_raw(key):
            if (it.get("fields", {}).get("Title") or "").strip().lower() == s:
                return it
        return None

    def get_new_stock(self) -> list[dict]:
        return [self._row(f["fields"], "new_stock") for f in self._items_raw("new_stock")]

    def get_in_use(self) -> list[dict]:
        return [self._row(f["fields"], "in_use", in_use=True) for f in self._items_raw("in_use")]

    @staticmethod
    def _field_value(f: dict, internal: str | None) -> str:
        """Read a field value as a string, tolerating text, person/lookup (dict),
        and multi-value (list) columns."""
        if not internal:
            return ""
        v = f.get(internal)
        if v is None:
            v = f.get(internal + "LookupId")  # person/lookup columns expose an id sibling
        if isinstance(v, dict):
            return v.get("LookupValue") or v.get("Email") or v.get("Title") or v.get("displayName") or ""
        if isinstance(v, list):
            out = []
            for x in v:
                if isinstance(x, dict):
                    out.append(x.get("LookupValue") or x.get("Email") or x.get("Title") or "")
                elif x is not None:
                    out.append(str(x))
            return ", ".join(p for p in out if p)
        return v if isinstance(v, str) else ("" if v is None else str(v))

    def _row(self, f: dict, key: str, in_use: bool = False) -> dict:
        def val(logical):
            return self._field_value(f, self._internal_for(key, logical))
        row = {
            "serial": f.get("Title", ""),
            "manufacturer": val("manufacturer"),
            "model": val("model"),
            "site_tag": val("site_tag"),
            "cpu": val("cpu"),
            "ram": val("ram"),
            "storage": val("storage"),
            "warranty": val("warranty"),
        }
        if in_use:
            u = val("user")
            if not u:  # fallback: any column that looks like a user field
                for k in f:
                    kl = k.lower()
                    if (("user" in kl or "assigned" in kl) and "lookupid" not in kl
                            and kl not in ("author", "editor")):
                        cand = self._field_value(f, k)
                        if cand:
                            u = cand
                            break
            row["user"] = u
            row["device_name"] = val("device_name")
            row["os_version"] = val("os_version")
            row["os_install"] = val("os_install")
            row["last_checkin"] = val("last_checkin")
            row["mfa"] = val("mfa")
        else:
            row["date_added"] = val("date_added")
            # New Stock carries a lifecycle Status ("Stock" normally, "Boneyard" for
            # devices retired out of In Use). Blank/legacy rows are treated as Stock.
            row["status"] = val("status") or "Stock"
        return row

    # ---- writes -----------------------------------------------------------
    def add_new_stock(self, data: dict) -> None:
        fields = self._fields_for("new_stock", {
            "serial": data.get("serial"),
            "manufacturer": data.get("manufacturer"),
            "model": data.get("model"),
            "site_tag": data.get("site_tag"),
            "cpu": data.get("cpu"),
            "ram": data.get("ram"),
            "storage": data.get("storage"),
            "warranty": data.get("warranty"),
            "status": data.get("status") or "Stock",
            "date_added": _dt.date.today().isoformat(),
        })
        fields.setdefault("Title", data.get("serial"))
        self._create_item("new_stock", fields)

    def add_in_use(self, data: dict) -> None:
        fields = self._fields_for("in_use", {
            "serial": data.get("serial"),
            "device_name": data.get("device_name"),
            "manufacturer": data.get("manufacturer"),
            "model": data.get("model"),
            "site_tag": data.get("site_tag"),
            "user": data.get("user"),
            "cpu": data.get("cpu"),
            "ram": data.get("ram"),
            "storage": data.get("storage"),
            "os_version": data.get("os_version"),
            "os_install": data.get("os_install"),
            "last_checkin": data.get("last_checkin"),
            "warranty": data.get("warranty"),
            "mfa": data.get("mfa"),
        })
        fields.setdefault("Title", data.get("serial"))
        self._create_item("in_use", fields)

    def delete_item(self, key: str, item_id: str) -> None:
        if self._local:
            self._ls().delete(key, item_id)
            return
        site = self._ensure_site()
        self._req("DELETE", f"{GRAPH}/sites/{site}/lists/{self._list_id(key)}/items/{item_id}")

    def update_item(self, key: str, item_id: str, friendly_values: dict) -> None:
        """PATCH selected fields on an existing item (logical field -> value)."""
        fields = self._fields_for(key, friendly_values)
        if not fields:
            return
        if self._local:
            self._ls().patch(key, item_id, fields)
            return
        site = self._ensure_site()
        self._req("PATCH",
                  f"{GRAPH}/sites/{site}/lists/{self._list_id(key)}/items/{item_id}/fields",
                  json=fields)

    # ---- audit log --------------------------------------------------------
    def _ensure_log_list(self) -> str:
        if self._local:
            return "local:log"
        if "log" in self._list_ids:
            return self._list_ids["log"]
        site = self._ensure_site()
        want = self.cfg.get("lists", {}).get("log", "NBGW Inventory Log")
        wl = want.strip().lower()
        lists = self._get_all(f"{GRAPH}/sites/{site}/lists?$select=id,name,displayName")
        for l in lists:
            if wl in [(l.get("displayName") or "").strip().lower(), (l.get("name") or "").strip().lower()]:
                self._list_ids["log"] = l["id"]
                return l["id"]
        # create it (needs list-management rights; first runner/owner triggers this once)
        payload = {
            "displayName": want,
            "list": {"template": "genericList"},
            "columns": [
                {"name": "Action", "text": {}},
                {"name": "Serial", "text": {}},
                {"name": "Model", "text": {}},
                {"name": "Actor", "text": {}},
                {"name": "Details", "text": {}},
                {"name": "LoggedAt", "text": {}},
            ],
        }
        try:
            created = self._req("POST", f"{GRAPH}/sites/{site}/lists", json=payload).json()
        except GraphError:
            raise GraphError(
                f"Activity log list '{want}' doesn't exist and couldn't be created "
                "automatically (creating a list needs site Manage Lists / Full Control "
                f"rights). Ask a site owner to create a list named '{want}' with these "
                "single-line-text columns: Action, Serial, Model, Actor, Details, LoggedAt. "
                "Adds, deploys, and deletes keep working meanwhile and will log once it exists."
            )
        self._list_ids["log"] = created["id"]
        return created["id"]

    def add_log(self, action: str, serial: str = "", model: str = "",
                actor: str = "", details: str = "") -> None:
        """Write an audit entry. Never raises - logging must not block the action."""
        try:
            when = _dt.datetime.utcnow().isoformat(timespec="seconds") + "Z"
            fields = {"Title": f"{action} {serial}".strip(), "Action": action, "Serial": serial,
                      "Model": model, "Actor": actor, "Details": details, "LoggedAt": when}
            self._create_item("log", fields)
        except Exception:
            pass

    def get_log(self, top: int = 300) -> list[dict]:
        if self._local:
            items = self._ls().items("log")
        else:
            site = self._ensure_site()
            lid = self._ensure_log_list()
            items = self._only_division(self._get_all(
                f"{GRAPH}/sites/{site}/lists/{lid}/items?expand=fields&$top=200"
            ), "log")
        rows = []
        for it in items:
            f = it.get("fields", {})
            rows.append({
                "when": f.get("LoggedAt", "") or it.get("createdDateTime", ""),
                "action": f.get("Action", ""),
                "serial": f.get("Serial", ""),
                "model": f.get("Model", ""),
                "actor": f.get("Actor", ""),
                "details": f.get("Details", ""),
            })
        rows.sort(key=lambda r: r["when"], reverse=True)
        return rows[:top]
