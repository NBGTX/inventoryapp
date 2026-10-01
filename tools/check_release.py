"""Pre-release check of the config.json that will be shipped inside the installer.

    python tools\\check_release.py [path\\to\\config.json]

Fails (exit 1) if the config is missing required keys or contains anything secret-looking. Secrets belong in
the central Master Settings list (Settings > Platform > Integrations), never in a file we hand to every tech.
build.ps1 runs this before packaging.
"""
from __future__ import annotations

import json
import os
import re
import sys

REQUIRED = ("tenant_id", "client_id")
SECRET_NAME = re.compile(r"(secret|password|passwd|token|api[_-]?key|private|credential)", re.I)
# keys that look secret by name but are not (identifiers / non-secret flags)
ALLOWED = {"tenant_id", "client_id", "super_admins"}
# legacy key that used to hold a real vendor secret even though its name does not say so
ALWAYS_SECRET = {"lenovo_client_id"}


def scan(cfg: dict, prefix: str = "") -> list:
    """Return human-readable problems (empty list = OK)."""
    problems = []
    if not prefix:
        for k in REQUIRED:
            v = str(cfg.get(k) or "")
            if not v or v.upper().startswith("PASTE"):
                problems.append(f"'{k}' is not filled in")
        if not cfg.get("central"):
            problems.append("'central' (site_host/site_path of the central store) is missing")
    for k, v in cfg.items():
        name = prefix + k
        if isinstance(v, dict):
            problems += scan(v, name + ".")
        elif isinstance(v, str) and v.strip() and k not in ALLOWED:
            if k in ALWAYS_SECRET or SECRET_NAME.search(k):
                problems.append(f"'{name}' holds a value but looks like a secret: move it to Master Settings and blank it here")
    return problems


def strip_secrets(cfg: dict) -> tuple:
    """(clean copy, [names removed]). Used to build the config that ships in the installer from a developer's
    own config.json, which may still carry a legacy secret."""
    removed = []

    def walk(d, prefix=""):
        out = {}
        for k, v in d.items():
            if isinstance(v, dict):
                out[k] = walk(v, prefix + k + ".")
            elif isinstance(v, str) and v.strip() and k not in ALLOWED and (k in ALWAYS_SECRET or SECRET_NAME.search(k)):
                removed.append(prefix + k)
            else:
                out[k] = v
        return out
    return walk(cfg), removed


def main(argv: list) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    write_to = argv[argv.index("--write") + 1] if "--write" in argv else None
    if write_to and write_to in args:
        args.remove(write_to)
    path = args[0] if args else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")
    try:
        with open(path, encoding="utf-8-sig") as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        print(f"Cannot read {path}: {e}")
        return 1
    if write_to:                                      # ship a scrubbed copy; never touch the developer's own file
        cfg, removed = strip_secrets(cfg)
        for k in removed:
            print(f"  removed '{k}' from the shipped config (keep it in Master Settings)")
        os.makedirs(os.path.dirname(os.path.abspath(write_to)), exist_ok=True)
        with open(write_to, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        path = write_to
    problems = scan(cfg)
    for p in problems:
        print("  - " + p)
    print(("FAIL: " if problems else "OK: ") + path)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
