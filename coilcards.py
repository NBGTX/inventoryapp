"""BG Tools: Delete coil card (CoilCard database, integrated auth, parameterized).

Cascade found by inspecting the schema: dbo.CoilTracking.CoilID has a NO ACTION foreign key to
dbo.Card.NBSNumber, and nothing else references a card. So a delete is CoilTracking rows first,
then the Card row, in ONE transaction that rolls back unless exactly one Card row goes.
"""
from __future__ import annotations

import json
import re
from datetime import datetime

DEFAULTS = {"coilcard_db": "CoilCard", "coilcard_card_table": "dbo.Card",
            "coilcard_tracking_table": "dbo.CoilTracking"}
_NBS = re.compile(r"^[A-Za-z0-9._\-]{1,50}$")


def ident(name: str) -> str:
    """[schema].[table] from 'schema.table'/'table'; letters, digits, underscores only."""
    parts = (name or "").strip().split(".")
    if not parts or len(parts) > 2 or not all(re.fullmatch(r"[A-Za-z0-9_]+", p) for p in parts):
        raise ValueError(f"Bad SQL name '{name}'.")
    return ".".join(f"[{p}]" for p in parts)


def conf(gc) -> dict:
    """Database + table names (master setting > config.json > default)."""
    out = {}
    for k, d in DEFAULTS.items():
        out[k] = (gc.get_setting(k, "") or d).strip()
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", out["coilcard_db"]):
        raise ValueError("Database names may only contain letters, digits, - and _.")
    out["card"] = ident(out["coilcard_card_table"])
    out["track"] = ident(out["coilcard_tracking_table"])
    return out


def clean_nbs(nbs: str) -> str:
    v = (nbs or "").strip()
    if not _NBS.match(v):
        raise ValueError("Enter a coil card number (letters, digits, dot, dash).")
    return v


def preview(server: str, c: dict, nbs: str) -> dict:
    """Card details + tracking row count. Read only. {"found": False} if the card does not exist."""
    from sqltools import run
    nbs = clean_nbs(nbs)
    r = run(server, c["coilcard_db"],
            f"SELECT * FROM {c['card']} WHERE NBSNumber = @nbs", {"nbs": nbs})
    if "__error__" in r:
        raise RuntimeError(r["__error__"])
    rows = r.get("rows", [])
    if not rows:
        return {"found": False, "nbs": nbs}
    t = run(server, c["coilcard_db"],
            f"SELECT COUNT(*) AS n FROM {c['track']} WHERE CoilID = @nbs", {"nbs": nbs})
    if "__error__" in t:
        raise RuntimeError(t["__error__"])
    n = int((t.get("rows") or [{"n": 0}])[0].get("n") or 0)
    return {"found": True, "nbs": nbs, "card": rows[0], "tracking_rows": n}


def _backup(nbs: str, payload: dict, put, get) -> str:
    """Upload the rows as a JSON file and read it back. Any failure raises, so nothing is deleted."""
    name = f"coilcard-backup-{nbs}-{datetime.now():%Y%m%d-%H%M%S}.json"
    data = json.dumps(payload, indent=1).encode("utf-8")
    put(name, data)
    if get(name) != data:
        raise RuntimeError("Backup could not be verified in SharePoint; nothing was deleted.")
    return name


def delete(server: str, c: dict, nbs: str, put, get) -> dict:
    """Back up CoilTracking + Card rows via put(name, bytes)/get(name), then delete both in one transaction."""
    from sqltools import run
    nbs = clean_nbs(nbs)
    p = preview(server, c, nbs)
    if not p["found"]:
        raise RuntimeError(f"Coil card {nbs} not found.")
    tr = run(server, c["coilcard_db"], f"SELECT * FROM {c['track']} WHERE CoilID = @nbs", {"nbs": nbs})
    if "__error__" in tr:
        raise RuntimeError(tr["__error__"])
    backup = _backup(nbs, {"card": p["card"], "tracking": tr.get("rows", []), "server": server,
                           "db": c["coilcard_db"]}, put, get)
    sql = (
        "SET XACT_ABORT ON; BEGIN TRAN; DECLARE @t int, @c int; "
        f"DELETE FROM {c['track']} WHERE CoilID = @nbs; SET @t = @@ROWCOUNT; "
        f"DELETE FROM {c['card']} WHERE NBSNumber = @nbs; SET @c = @@ROWCOUNT; "
        "IF @c <> 1 BEGIN ROLLBACK TRAN; THROW 50001, 'Expected to delete exactly one card; rolled back.', 1; END; "
        "COMMIT TRAN; SELECT @t AS tracking, @c AS cards;")
    r = run(server, c["coilcard_db"], sql, {"nbs": nbs})
    if "__error__" in r:
        raise RuntimeError(r["__error__"])
    row = (r.get("rows") or [{}])[0]
    return {"tracking": int(row.get("tracking") or 0), "cards": int(row.get("cards") or 0),
            "backup": backup, "card": p["card"]}
