"""Dell and HP warranty/model lookups by serial number (Lenovo stays in graph.py).

Credentials come from Master Settings (Settings > Platform > Integrations): dell_client_id / dell_client_secret
(Dell TechDirect, authorised for the Warranty API) and hp_client_id / hp_client_secret (HP Product Warranty API
key + secret, requested from HP). Neither vendor returns CPU/RAM/storage; they give model + warranty end date.

Every function returns {"model", "cpu", "ram", "storage", "warranty_end"} (same shape as lookup_lenovo) or None,
and NEVER raises. Secrets are never logged.

The Dell calls follow Dell's documented OAuth2 client-credentials flow and asset-entitlements v5 response.
The HP response parser is tolerant (it searches the JSON) because HP's response layout could not be checked
without credentials: run  python tools\\vendor_probe.py hp <serial>  once keys exist and adjust if needed.
"""
from __future__ import annotations

import time

import requests

DELL_TOKEN_URL = "https://apigtwb2c.us.dell.com/auth/oauth/v2/token"
DELL_ENTITLEMENTS_URL = "https://apigtwb2c.us.dell.com/PROD/sbil/eapi/v5/asset-entitlements"
HP_TOKEN_URL = "https://css.api.hp.com/oauth/v1/token"
HP_QUERIES_URL = "https://css.api.hp.com/productWarranty/v1/queries"

_TOKENS: dict = {}          # vendor -> (access_token, expires_at_monotonic)


def vendor_of(manufacturer: str) -> str:
    """'lenovo' | 'dell' | 'hp' | '' from an Intune/SharePoint manufacturer string."""
    m = (manufacturer or "").lower()
    if "lenovo" in m:
        return "lenovo"
    if "dell" in m:
        return "dell"
    if m.startswith("hp") or "hewlett" in m or " hp" in m:
        return "hp"
    return ""


def _empty() -> dict:
    return {"model": "", "cpu": "", "ram": "", "storage": "", "warranty_end": ""}


def _date10(v) -> str:
    s = str(v or "").strip()
    return s[:10] if len(s) >= 10 and s[4:5] == "-" else ""


def _token(vendor: str, url: str, make_request) -> str:
    tok, exp = _TOKENS.get(vendor, ("", 0.0))
    if tok and time.monotonic() < exp - 60:
        return tok
    r = make_request()
    if not r.ok:
        return ""
    d = r.json()
    tok = d.get("access_token") or d.get("accessToken") or d.get("token") or ""
    if tok:
        _TOKENS[vendor] = (tok, time.monotonic() + float(d.get("expires_in") or d.get("expiresIn") or 3000))
    return tok


def clear_tokens() -> None:
    _TOKENS.clear()


# ---------------------------------------------------------------------------------------- Dell
def lookup_dell(client_id: str, client_secret: str, service_tag: str) -> dict | None:
    tag = (service_tag or "").strip()
    if not (client_id and client_secret and tag):
        return None
    try:
        tok = _token("dell", DELL_TOKEN_URL, lambda: requests.post(
            DELL_TOKEN_URL, data={"client_id": client_id, "client_secret": client_secret, "grant_type": "client_credentials"},
            timeout=20))
        if not tok:
            return None
        r = requests.get(DELL_ENTITLEMENTS_URL, params={"servicetags": tag},
                         headers={"Authorization": f"Bearer {tok}", "Accept": "application/json"}, timeout=20)
        if r.status_code == 401:
            _TOKENS.pop("dell", None)
            return None
        if not r.ok:
            return None
        data = r.json()
        asset = (data[0] if isinstance(data, list) and data else data) or {}
        if asset.get("invalid"):
            return None
        out = _empty()
        out["model"] = _clean_model(asset.get("systemDescription") or asset.get("productLineDescription") or "")
        ends = [_date10(e.get("endDate")) for e in (asset.get("entitlements") or []) if isinstance(e, dict)]
        out["warranty_end"] = max([e for e in ends if e], default="")
        return out if (out["model"] or out["warranty_end"]) else None
    except Exception:
        return None


def _clean_model(name: str) -> str:
    name = " ".join(str(name or "").split())
    for pre in ("Dell ", "DELL "):
        if name.startswith(pre):
            name = name[len(pre):]
    return name


# ------------------------------------------------------------------------------------------ HP
def lookup_hp(api_key: str, api_secret: str, serial: str) -> dict | None:
    sn = (serial or "").strip()
    if not (api_key and api_secret and sn):
        return None
    try:
        tok = _token("hp", HP_TOKEN_URL, lambda: requests.post(
            HP_TOKEN_URL, json={"apiKey": api_key, "apiSecret": api_secret, "grantType": "client_credentials", "scope": "warranty"},
            headers={"Accept": "application/json"}, timeout=20))
        if not tok:
            return None
        r = requests.post(HP_QUERIES_URL, json=[{"sn": sn}],
                          headers={"Authorization": f"Bearer {tok}", "Accept": "application/json"}, timeout=30)
        if r.status_code == 401:
            _TOKENS.pop("hp", None)
            return None
        if not r.ok:
            return None
        return parse_hp(r.json())
    except Exception:
        return None


def _walk(node):
    """Yield (key, value) for every key in a nested JSON structure."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield k, v
            yield from _walk(v)
    elif isinstance(node, list):
        for item in node:
            yield from _walk(item)


def parse_hp(data) -> dict | None:
    """Tolerant: latest *end* date found anywhere, and the first product name/description-looking text."""
    out = _empty()
    ends, names = [], {}
    for k, v in _walk(data):
        kl = str(k).lower()
        if isinstance(v, str):
            if "end" in kl and "date" in kl and _date10(v):
                ends.append(_date10(v))
            elif kl in _HP_NAME_KEYS and v.strip():
                names.setdefault(kl, v.strip())
    out["warranty_end"] = max(ends, default="")
    for key in _HP_NAME_KEYS:                      # most specific field first
        if key in names:
            out["model"] = _clean_model(names[key])
            break
    return out if (out["model"] or out["warranty_end"]) else None


_HP_NAME_KEYS = ("productname", "productdescription", "productmodel", "model", "description")
