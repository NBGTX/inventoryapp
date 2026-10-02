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
FORMAT = 2                                   # backup file layout; 2 = exact values (NULLs kept)
PREFIX = "coilcard-backup-"
_BACKUP_NAME = re.compile(r"^coilcard-backup-[A-Za-z0-9._\-]+\.json$")
_SKIP_TYPES = {"timestamp", "rowversion"}
_BINARY = {"binary", "varbinary", "image"}


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
    # exact rows (NULLs, ISO dates, hex bytes) so a restore can put them back unchanged
    cr = run(server, c["coilcard_db"], f"SELECT * FROM {c['card']} WHERE NBSNumber = @nbs", {"nbs": nbs}, exact=True)
    tr = run(server, c["coilcard_db"], f"SELECT * FROM {c['track']} WHERE CoilID = @nbs", {"nbs": nbs}, exact=True)
    for x in (cr, tr):
        if "__error__" in x:
            raise RuntimeError(x["__error__"])
    backup = _backup(nbs, {"format": FORMAT, "nbs": nbs, "server": server, "db": c["coilcard_db"],
                           "card_table": c["coilcard_card_table"], "tracking_table": c["coilcard_tracking_table"],
                           "card": (cr.get("rows") or [{}])[0], "tracking": tr.get("rows", [])}, put, get)
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


# ---------------------------------------------------------------- restore
def read_backup(name: str, get) -> dict:
    """Load and sanity-check a backup file written by delete()."""
    if not _BACKUP_NAME.match(name or ""):
        raise ValueError("Not a coil card backup file.")
    raw = get(name)
    if raw is None:
        raise RuntimeError("Backup file not found.")
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except ValueError:
        raise RuntimeError("Backup file is not valid JSON.")
    if data.get("format") != FORMAT or not isinstance(data.get("card"), dict) or not isinstance(data.get("tracking"), list):
        raise RuntimeError("Backup was made by an older version and cannot be restored automatically.")
    nbs = clean_nbs(data["card"].get("NBSNumber") or "")
    for t in data["tracking"]:
        if (t.get("CoilID") or "") != nbs:
            raise RuntimeError("Backup file is inconsistent (a tracking row belongs to another card).")
    return data


def _columns(server: str, c: dict, table_sql: str) -> list:
    from sqltools import run
    r = run(server, c["coilcard_db"],
            "SELECT c.name, c.is_identity, c.is_computed, ty.name AS typ FROM sys.columns c "
            "JOIN sys.types ty ON ty.user_type_id = c.user_type_id WHERE c.object_id = OBJECT_ID(@t)",
            {"t": table_sql})
    if "__error__" in r:
        raise RuntimeError(r["__error__"])
    cols = [{"name": x["name"], "identity": str(x.get("is_identity")).lower() in ("1", "true"),
             "computed": str(x.get("is_computed")).lower() in ("1", "true"), "typ": x.get("typ", "")}
            for x in r.get("rows", [])]
    if not cols:
        raise RuntimeError(f"Table {table_sql} not found.")
    return cols


def _lit(v, binary: bool = False) -> str:
    if v is None:
        return "NULL"
    s = str(v)
    if binary and re.fullmatch(r"0x[0-9A-Fa-f]+", s):
        return s
    return "N'" + s.replace("'", "''") + "'"


def _insert(table_sql: str, cols: list, row: dict) -> str:
    use = [m for m in cols if not m["computed"] and m["typ"] not in _SKIP_TYPES and m["name"] in row]
    known = {m["name"] for m in cols}
    extra = [k for k in row if k not in known]
    if extra:
        raise RuntimeError(f"Backup has columns the table no longer has: {', '.join(extra)}.")
    names = ", ".join("[" + m["name"].replace("]", "]]") + "]" for m in use)
    vals = ", ".join(_lit(row[m["name"]], m["typ"] in _BINARY) for m in use)
    return f"INSERT INTO {table_sql} ({names}) VALUES ({vals});"


def restore_plan(server: str, c: dict, data: dict) -> dict:
    """Read-only: what a restore would do, and whether it is allowed now."""
    from sqltools import run
    nbs = data["card"]["NBSNumber"]
    ex = run(server, c["coilcard_db"], f"SELECT COUNT(*) AS n FROM {c['card']} WHERE NBSNumber = @nbs", {"nbs": nbs})
    tx = run(server, c["coilcard_db"], f"SELECT COUNT(*) AS n FROM {c['track']} WHERE CoilID = @nbs", {"nbs": nbs})
    for x in (ex, tx):
        if "__error__" in x:
            raise RuntimeError(x["__error__"])
    card_exists = int((ex.get("rows") or [{"n": 0}])[0]["n"] or 0) > 0
    track_exists = int((tx.get("rows") or [{"n": 0}])[0]["n"] or 0)
    return {"nbs": nbs, "card": data["card"], "tracking_rows": len(data["tracking"]),
            "card_exists": card_exists, "tracking_existing": track_exists,
            "can_restore": not card_exists and track_exists == 0}


def restore(server: str, c: dict, data: dict) -> dict:
    """Insert the Card row, then its CoilTracking rows, in one transaction. Refuses when the card or
    any of its tracking rows already exists; rolls back unless every row went in."""
    from sqltools import run
    plan = restore_plan(server, c, data)
    if plan["card_exists"]:
        raise RuntimeError(f"Card {plan['nbs']} already exists; nothing restored.")
    if plan["tracking_existing"]:
        raise RuntimeError(f"Card {plan['nbs']} already has tracking rows; nothing restored.")
    ccols, tcols = _columns(server, c, c["card"]), _columns(server, c, c["track"])
    n = len(data["tracking"])
    sql = ["SET XACT_ABORT ON; BEGIN TRAN; DECLARE @t int = 0, @r int;"]
    cid = any(m["identity"] for m in ccols)
    if cid:
        sql.append(f"SET IDENTITY_INSERT {c['card']} ON;")
    sql.append(_insert(c["card"], ccols, data["card"]))
    sql.append("SET @r = @@ROWCOUNT;")
    if cid:
        sql.append(f"SET IDENTITY_INSERT {c['card']} OFF;")
    sql.append("IF @r <> 1 THROW 50004, 'Card was not restored; rolled back.', 1;")
    tid = any(m["identity"] for m in tcols)
    if n and tid:
        sql.append(f"SET IDENTITY_INSERT {c['track']} ON;")
    for row in data["tracking"]:
        sql.append(_insert(c["track"], tcols, row))
        sql.append("SET @t += @@ROWCOUNT;")
    if n and tid:
        sql.append(f"SET IDENTITY_INSERT {c['track']} OFF;")
    sql.append(f"IF @t <> {n} THROW 50005, 'Not every tracking row was restored; rolled back.', 1;")
    sql.append("COMMIT TRAN; SELECT @t AS tracking, @r AS cards;")
    r = run(server, c["coilcard_db"], " ".join(sql))
    if "__error__" in r:
        raise RuntimeError(r["__error__"])
    row = (r.get("rows") or [{}])[0]
    return {"nbs": plan["nbs"], "cards": int(row.get("cards") or 0), "tracking": int(row.get("tracking") or 0)}
