"""Bump (or check) the app version everywhere it lives - CLAUDE.md Rule 3.

    python tools/bump_version.py            # next version: today's date, or today + .2, .3 if already used today
    python tools/bump_version.py --set 2026.10.15
    python tools/bump_version.py --check    # exit 1 if the files disagree (build.ps1 runs this)

Files: version.py (APP_VERSION), version.txt (filevers / prodvers / FileVersion / ProductVersion),
web/app.js (Mock app_version + register_client strings).
"""
from __future__ import annotations

import argparse
import datetime
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P_PY = os.path.join(ROOT, "version.py")
P_TXT = os.path.join(ROOT, "version.txt")
P_JS = os.path.join(ROOT, "web", "app.js")
RX_PY = re.compile(r'APP_VERSION\s*=\s*"([^"]+)"')
RX_VER = re.compile(r"^\d{4}\.\d{2}\.\d{2}(\.\d+)?$")


def _read(p):
    with open(p, encoding="utf-8", newline="") as f:
        return f.read()


def _write(p, s):
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(s)


def current() -> str:
    return RX_PY.search(_read(P_PY)).group(1)


def next_version(cur: str) -> str:
    today = datetime.date.today().strftime("%Y.%m.%d")
    if not cur.startswith(today):
        return today
    n = int(cur.split(".")[3]) + 1 if cur.count(".") == 3 else 2
    return f"{today}.{n}"


def tuple_of(v: str) -> str:
    p = [int(x) for x in v.split(".")]
    while len(p) < 4:
        p.append(0)
    return "(" + ", ".join(str(x) for x in p) + ")"


def found_versions() -> dict:
    txt, js = _read(P_TXT), _read(P_JS)
    out = {"version.py": current()}
    m = re.search(r"StringStruct\('FileVersion', '([^']+)'\)", txt)
    out["version.txt FileVersion"] = m.group(1) if m else "?"
    m = re.search(r"StringStruct\('ProductVersion', '([^']+)'\)", txt)
    out["version.txt ProductVersion"] = m.group(1) if m else "?"
    m = re.search(r"async app_version\(\)[^\n]*version: \"([^\"]+)\"", js)
    out["web/app.js Mock app_version"] = m.group(1) if m else "?"
    m = re.search(r"async register_client\(\)[^\n]*version: \"([^\"]+)\"", js)
    out["web/app.js Mock register_client"] = m.group(1) if m else "?"
    return out


def apply(v: str) -> None:
    _write(P_PY, RX_PY.sub(f'APP_VERSION = "{v}"', _read(P_PY)))
    t = _read(P_TXT)
    t = re.sub(r"filevers=\([^)]*\)", "filevers=" + tuple_of(v), t)
    t = re.sub(r"prodvers=\([^)]*\)", "prodvers=" + tuple_of(v), t)
    t = re.sub(r"(StringStruct\('FileVersion', ')[^']+('\))", r"\g<1>" + v + r"\2", t)
    t = re.sub(r"(StringStruct\('ProductVersion', ')[^']+('\))", r"\g<1>" + v + r"\2", t)
    _write(P_TXT, t)
    js = _read(P_JS)
    js = re.sub(r'(async app_version\(\)[^\n]*version: ")[^"]+(")', r"\g<1>" + v + r"\2", js)
    js = re.sub(r'(async register_client\(\)[^\n]*version: ")[^"]+(")', r"\g<1>" + v + r"\2", js)
    _write(P_JS, js)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set", dest="setv")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    if a.check:
        f = found_versions()
        for k, v in f.items():
            print(f"  {k:36} {v}")
        if len(set(f.values())) != 1:
            print("Version files disagree. Run: python tools/bump_version.py --set <version>")
            return 1
        print("Versions consistent:", current())
        return 0
    v = a.setv or next_version(current())
    if not RX_VER.match(v):
        print("Version must look like YYYY.MM.DD or YYYY.MM.DD.N")
        return 2
    apply(v)
    print("Version ->", v)
    return bump_check()


def bump_check() -> int:
    f = found_versions()
    return 0 if len(set(f.values())) == 1 else 1


if __name__ == "__main__":
    sys.exit(main())
