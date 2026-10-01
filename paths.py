"""Per-user app data folder (token cache, division choice, data mode, local snapshots).

Renamed "NBGW Hub" -> "NBG Hub". On first run under the new name the old folder is
COPIED (not moved) so the sign-in token cache carries over and an older exe keeps working.
"""
from __future__ import annotations

import os
import shutil

APP_DIR_NAME = "NBG Hub"
_OLD_DIR_NAME = "NBGW Hub"


def user_dir() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    new = os.path.join(base, APP_DIR_NAME)
    old = os.path.join(base, _OLD_DIR_NAME)
    if not os.path.exists(new) and os.path.isdir(old):
        try:
            shutil.copytree(old, new)
        except Exception:
            pass   # best effort: worst case the user signs in again
    return new
