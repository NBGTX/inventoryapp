"""Packaging self-test and WebView2 detection.

    "NBG Hub.exe" --selftest <result-file>

Imports every module the app needs, checks the bundled web files, and writes PASS/FAIL lines to
<result-file> (a windowed exe has no console). build.ps1 runs this against the freshly built exe, so a
missing --hidden-import or web asset fails the BUILD instead of failing on a tech's PC.
Exit code 0 = pass.
"""
from __future__ import annotations

import importlib
import os
import sys

# Every local module the app imports (some lazily), plus the third-party ones PyInstaller can miss.
MODULES = ["app", "graph", "hub", "hubstore", "divisions", "localstore", "paths", "schema", "securecache",
           "settings_catalog", "vendors", "synclock", "sync", "adlookup", "sqltools", "version", "selftest",
           "msal", "requests", "truststore", "webview", "clr", "clr_loader", "cffi"]
WEB_FILES = ["index.html", "app.js", "settings.js", "styles.css", "hub-mark.svg"]

# Evergreen WebView2 runtime: its "pv" (version) value exists under this client id.
_WV2_KEY = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"


def webview2_version() -> str:
    """Installed WebView2 runtime version ('' if none). Checks machine and per-user installs."""
    try:
        import winreg
    except ImportError:
        return ""
    for hive, key in ((winreg.HKEY_LOCAL_MACHINE, _WV2_KEY),
                      (winreg.HKEY_LOCAL_MACHINE, _WV2_KEY.replace("SOFTWARE\\", "SOFTWARE\\WOW6432Node\\", 1)),
                      (winreg.HKEY_CURRENT_USER, _WV2_KEY)):
        try:
            with winreg.OpenKey(hive, key) as k:
                v = str(winreg.QueryValueEx(k, "pv")[0] or "")
                if v and v != "0.0.0.0":
                    return v
        except OSError:
            continue
    return ""


def require_webview2() -> None:
    """Called at launch: show a plain message (not a stack trace) if the runtime is missing."""
    if os.name != "nt" or webview2_version():
        return
    msg = ("NBG Hub needs the Microsoft Edge WebView2 Runtime, which is not installed on this PC.\n\n"
           "Re-run the NBG Hub installer (it includes the runtime), or ask IT to install the "
           "'WebView2 Runtime' from Microsoft.")
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, msg, "NBG Hub", 0x10)
    except Exception:
        print(msg)
    sys.exit(2)


def _web_dir() -> str:
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "web")


def run(out_path: str | None = None) -> int:
    lines, ok = [], True

    def note(passed: bool, text: str) -> None:
        nonlocal ok
        ok = ok and passed
        lines.append(("PASS " if passed else "FAIL ") + text)

    for m in MODULES:
        try:
            importlib.import_module(m)
            note(True, f"import {m}")
        except Exception as e:
            note(False, f"import {m}: {type(e).__name__}: {e}")
    for f in WEB_FILES:
        note(os.path.isfile(os.path.join(_web_dir(), f)), f"web/{f}")
    try:
        import version
        note(bool(version.APP_VERSION), f"version {version.APP_VERSION}")
    except Exception as e:
        note(False, f"version: {e}")
    wv = webview2_version()
    lines.append(("INFO " if wv else "WARN ") + (f"WebView2 runtime {wv}" if wv else "WebView2 runtime not found on this PC"))
    lines.append("RESULT " + ("PASS" if ok else "FAIL"))
    text = "\n".join(lines) + "\n"
    if out_path:
        try:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(text)
        except OSError:
            ok = False
    else:
        print(text)
    return 0 if ok else 1
