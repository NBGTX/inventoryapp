#!/usr/bin/env python3
"""
NBGW Inventory - sign-in + read proof-of-concept.

Proves the two load-bearing facts for a per-user desktop app before we build the
whole thing:

  1. Each IT person can sign in with their OWN Nucor account (Entra / MSAL,
     public client, PKCE) with NO secret stored anywhere in the app.
  2. That same sign-in can (a) read the Intune managed-device inventory and
     (b) read the NBGW SharePoint site / lists - using only the signed-in
     user's own permissions.

If this script prints "ALL CORE CHECKS PASSED", the desktop-app design is
unblocked and the rest is routine. The most important line is the Intune one:
if it says 403, your account needs an Intune "read devices" role assigned.

Usage:
    python test_intune_signin.py                 # run the three core checks
    python test_intune_signin.py C02XL1AAJTGH    # also try one serial lookup

Setup:
    1. pip install msal requests   (see README.md if the proxy corrupts it)
    2. copy config.example.json -> config.json and fill in tenant_id + client_id
"""
import json
import os
import sys
import warnings

# Harmless: requests warns if charset-normalizer isn't installed. Graph responses
# declare their charset, so JSON parsing is unaffected. Silence the noise.
warnings.filterwarnings("ignore", message="Unable to find acceptable character detection")

try:
    import msal
    import requests
except ImportError:
    sys.exit("Missing dependencies. Run:  pip install msal requests   (see README.md)")

# Verify TLS against the Windows trust store (has the corporate proxy's root CA),
# else HTTPS fails with CERTIFICATE_VERIFY_FAILED behind the intercepting proxy.
try:
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass

GRAPH = "https://graph.microsoft.com/v1.0"
# Read-only scopes for the test. The real app adds Sites.ReadWrite.All for writes.
SCOPES = ["User.Read", "DeviceManagementManagedDevices.Read.All", "Sites.Read.All"]
HERE = os.path.dirname(os.path.abspath(__file__))


def load_config():
    path = os.path.join(HERE, "config.json")
    if not os.path.exists(path):
        sys.exit(
            "Missing config.json - copy config.example.json to config.json and "
            "fill in tenant_id + client_id."
        )
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    for key in ("tenant_id", "client_id"):
        if not cfg.get(key) or cfg[key].startswith("PASTE"):
            sys.exit(f"config.json: '{key}' is not filled in yet.")
    return cfg


def sign_in(cfg):
    # Persist the token cache so you are not re-prompted every run.
    # NOTE: production will back this with Windows DPAPI via msal-extensions;
    # a plaintext cache file is fine only for this local test.
    cache_path = os.path.join(HERE, ".token_cache.bin")
    cache = msal.SerializableTokenCache()
    if os.path.exists(cache_path):
        cache.deserialize(open(cache_path, encoding="utf-8").read())

    app = msal.PublicClientApplication(
        cfg["client_id"],
        authority=f"https://login.microsoftonline.com/{cfg['tenant_id']}",
        token_cache=cache,
    )

    result = None
    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
    if not result:
        print("Opening your browser to sign in with your Nucor account...\n")
        result = app.acquire_token_interactive(SCOPES)

    if cache.has_state_changed:
        open(cache_path, "w", encoding="utf-8").write(cache.serialize())

    if "access_token" not in result:
        sys.exit(
            f"Sign-in failed: {result.get('error')}: {result.get('error_description')}"
        )
    return result["access_token"]


def get(token, url):
    return requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)


def main():
    cfg = load_config()
    token = sign_in(cfg)
    ok = True
    sel = "serialNumber,manufacturer,model,userPrincipalName,osVersion,operatingSystem"

    # Test 1 - who am I (confirms basic Graph works)
    r = get(token, f"{GRAPH}/me")
    if r.ok:
        me = r.json()
        print(f"[PASS] Signed in as {me.get('displayName')} <{me.get('userPrincipalName')}>")
    else:
        ok = False
        print(f"[FAIL] /me returned {r.status_code}: {r.text[:200]}")

    # Test 2 - Intune managed devices (THE make-or-break check)
    r = get(token, f"{GRAPH}/deviceManagement/managedDevices?$top=5&$select={sel}")
    if r.ok:
        devs = r.json().get("value", [])
        print(f"[PASS] Intune read works - sample of {len(devs)} device(s):")
        for d in devs:
            print(
                f"        {d.get('serialNumber', '?'):<18} "
                f"{d.get('manufacturer', '?')} {d.get('model', '?')}  -> "
                f"{d.get('userPrincipalName') or '(unassigned)'}"
            )
        if not devs:
            print(
                "        (0 devices returned - your Intune role may be scoped to no/other "
                "devices. Verify scope with an Intune admin.)"
            )
    elif r.status_code == 403:
        ok = False
        print("[FAIL] Intune read = 403 Forbidden. Your account has NO Intune 'read devices' role.")
        print("        -> An Intune admin must assign you a role (e.g. Help Desk Operator)")
        print("           scoped to all devices. This is the one true prerequisite.")
    else:
        ok = False
        print(f"[FAIL] Intune read returned {r.status_code}: {r.text[:200]}")

    # Test 3 - SharePoint site + lists
    host = cfg.get("sharepoint_hostname", "nucor.sharepoint.com")
    spath = cfg.get("site_path", "/sites/NBGW/systems")
    r = get(token, f"{GRAPH}/sites/{host}:{spath}")
    if r.ok:
        site_id = r.json()["id"]
        print(f"[PASS] SharePoint site resolved: {r.json().get('displayName') or spath}")
        r2 = get(token, f"{GRAPH}/sites/{site_id}/lists?$select=name,displayName")
        if r2.ok:
            names = [l.get("displayName") or l.get("name") for l in r2.json().get("value", [])]
            print(f"[PASS] Lists visible ({len(names)}): {', '.join(names)}")
        else:
            ok = False
            print(f"[FAIL] Could not read lists: {r2.status_code}: {r2.text[:200]}")
    else:
        ok = False
        print(f"[FAIL] Site resolve returned {r.status_code}: {r.text[:200]}")

    # Optional Test 4 - one serial lookup, exactly what the "add machine" flow does
    if len(sys.argv) > 1:
        serial = sys.argv[1]
        r = get(
            token,
            f"{GRAPH}/deviceManagement/managedDevices?"
            f"$filter=serialNumber eq '{serial}'&$select={sel}",
        )
        if r.ok:
            hits = r.json().get("value", [])
            if hits:
                d = hits[0]
                print(
                    f"[PASS] Serial {serial}: {d.get('manufacturer')} {d.get('model')} -> "
                    f"{d.get('userPrincipalName') or '(unassigned)'}"
                )
            else:
                print(f"[ -- ] Serial {serial}: not in Intune (would fall through to manual model entry).")
        else:
            print(f"[FAIL] Serial lookup returned {r.status_code}: {r.text[:200]}")

    print()
    if ok:
        print("RESULT: ALL CORE CHECKS PASSED - the desktop-app design is unblocked.")
    else:
        print("RESULT: One or more checks failed - see [FAIL] lines above before building the full app.")


if __name__ == "__main__":
    main()
