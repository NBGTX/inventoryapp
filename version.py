"""Single source of truth for the app version.

Bump APP_VERSION on every build you hand out. It's shown in the sidebar and
reported (with the user + machine) to the shared hub on launch, so you can see
which version each person is running from the "Versions in use" list.
Keep version.txt's FileVersion/ProductVersion in sync for the exe metadata.
"""
APP_VERSION = "2026.10.05.2"


def parse(v: str) -> tuple:
    """'2026.10.01' / '2026.10.01.2' -> (2026, 10, 1, 0) / (2026, 10, 1, 2); () if not a version."""
    parts = str(v or "").strip().split(".")
    if len(parts) not in (3, 4) or not all(p.isdigit() for p in parts):
        return ()
    nums = [int(p) for p in parts]
    return tuple(nums + [0] * (4 - len(nums)))
