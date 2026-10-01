"""Shared test setup. Import this FIRST in every test module.

- Sends all per-user data (token cache, local snapshots, division choice) to a temp folder, so
  tests never touch the developer's real %LOCALAPPDATA%\\NBG Hub.
- Stubs third-party packages that may be missing (msal, requests, truststore, webview).
- Never reads the real config.json: tests build GraphClient(config=...) explicitly.
- Never touches the network: tests replace the REST seams with in-memory fakes.
"""
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ["LOCALAPPDATA"] = tempfile.mkdtemp(prefix="nbghub-test-")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))

for _m in ("msal", "requests", "truststore", "webview"):
    try:
        __import__(_m)
    except ImportError:
        sys.modules[_m] = types.ModuleType(_m)
if not hasattr(sys.modules["msal"], "PublicClientApplication"):
    sys.modules["msal"].PublicClientApplication = object
    sys.modules["msal"].SerializableTokenCache = object
if not hasattr(sys.modules["truststore"], "inject_into_ssl"):
    sys.modules["truststore"].inject_into_ssl = lambda: None
if not hasattr(sys.modules["requests"], "Session"):
    sys.modules["requests"].Session = object

BASE_CFG = {"tenant_id": "t", "client_id": "c", "lenovo_client_id": "",
            "sharepoint_hostname": "nucor.sharepoint.com", "site_path": "/sites/NBGW/systems",
            "lists": {"new_stock": "NBGW Computers New Stock", "in_use": "NBGW Computers In Use",
                      "model_specs": "Model Spec References"}}

CENTRAL = {"site_host": "nucor.sharepoint.com", "site_path": "/sites/NBGTX.nbghubdata"}


def make_client(central=True, extra=None):
    """A GraphClient on a synthetic config, with no network. Tests attach fakes afterwards."""
    import graph
    cfg = dict(BASE_CFG)
    if central:
        cfg["central"] = dict(CENTRAL)
    cfg.update(extra or {})
    gc = graph.GraphClient(config=cfg)
    gc.data_mode = "live"
    gc._ls_reset = None
    gc._apply_division()
    return gc


class FakeSite:
    """In-memory SharePoint lists for a GraphClient: replaces _items_raw/_req/_col_map/ids."""

    def __init__(self, gc, colmaps=None):
        self.gc = gc
        self.rows = {}          # list key -> [ {"id","fields"} ]
        self.sent = []          # (method, tail, json)
        self._n = 0
        gc._ensure_site = lambda: "S"
        gc._list_id = lambda k: "L" + k
        gc._ensure_log_list = lambda: "Llog"
        gc._col_map = lambda k: (colmaps or {}).get(k, DEFAULT_COLS)
        gc._items_raw = lambda k: gc._only_division(list(self.rows.get(k, [])), k)
        gc._get_all = lambda u: []
        gc._req = self._req
        gc.add_log = lambda *a, **k: self.sent.append(("LOG", a, k))

    def add(self, key, **fields):
        self._n += 1
        row = {"id": str(self._n), "fields": fields}
        self.rows.setdefault(key, []).append(row)
        return row

    def _req(self, method, url, **kw):
        body = kw.get("json")
        self.sent.append((method, url.split("/")[-1], body))
        fake = self

        class R:
            def json(self):
                return {}
        return R()


DEFAULT_COLS = {"title": "Title", "division": "Division", "manufacturer": "Manufacturer", "model": "Model",
                "site tag": "SiteTag", "cpu": "CPU", "memory (ram)": "MemoryRAM", "storage": "Storage",
                "primary user": "PrimaryUser", "device name": "DeviceName",
                "display name": "DisplayName", "company name": "CompanyName", "intune category": "IntuneCategory",
                "sharepoint host": "SharePointHost", "site path": "SitePath", "ad domain": "AdDomain",
                "sql server": "SqlServer", "sites json": "SitesJson", "access json": "AccessJson", "enabled": "Enabled",
                "value": "Value", "secret": "Secret", "description": "Description"}
