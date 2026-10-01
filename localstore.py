"""Local data mode: a read-only snapshot of production kept in per-user SQLite.

Lets the app run (including launch-time sync) with every SharePoint-list and hub
write going to this machine only. Lives under %LOCALAPPDATA%\\NBG Hub\\local\\<division>\\
- never in the synced/shared folder and never in the repo.

  local.db       lists snapshot: cols (column map per list) + items (Graph-shaped rows)
  SystemsData\\   copy of the division's hub folder (Hub reads/writes here in local mode)
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import sqlite3
import uuid

import paths

_BASE = paths.user_dir()


def _safe(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", s or "_")


def division_dir(div_id: str) -> str:
    return os.path.join(_BASE, "local", _safe(div_id))


def hub_logs_dir(div_id: str) -> str:
    """Folder to hand to Hub(logs_folder=...) in local mode."""
    return os.path.join(division_dir(div_id), "SystemsData")


# ---- mode (live | local), remembered per machine --------------------------------
def _mode_path() -> str:
    return os.path.join(_BASE, "data_mode.txt")


def load_mode() -> str:
    try:
        with open(_mode_path(), encoding="utf-8") as f:
            return "local" if f.read().strip() == "local" else "live"
    except OSError:
        return "live"


def save_mode(mode: str) -> None:
    try:
        os.makedirs(_BASE, exist_ok=True)
        with open(_mode_path(), "w", encoding="utf-8") as f:
            f.write("local" if mode == "local" else "live")
    except OSError:
        pass


class LocalStore:
    def __init__(self, div_id: str):
        self.div_id = div_id
        self.dir = division_dir(div_id)
        os.makedirs(self.dir, exist_ok=True)
        self.path = os.path.join(self.dir, "local.db")
        with self._c() as c:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
                CREATE TABLE IF NOT EXISTS cols(list_key TEXT PRIMARY KEY, json TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS items(
                  list_key TEXT NOT NULL, id TEXT NOT NULL, fields TEXT NOT NULL,
                  created TEXT, PRIMARY KEY(list_key, id));
            """)

    def _c(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=10)
        c.execute("PRAGMA journal_mode=WAL")
        return c

    # ---- snapshot -----------------------------------------------------------
    def has_snapshot(self) -> bool:
        return bool(self.info().get("taken_at"))

    def info(self) -> dict:
        with self._c() as c:
            meta = dict(c.execute("SELECT k, v FROM meta").fetchall())
            counts = dict(c.execute("SELECT list_key, COUNT(*) FROM items GROUP BY list_key").fetchall())
        return {"taken_at": meta.get("taken_at", ""), "taken_by": meta.get("taken_by", ""),
                "counts": counts, "path": self.dir}

    def replace_list(self, key: str, colmap: dict, items: list[dict]) -> None:
        with self._c() as c:
            c.execute("DELETE FROM items WHERE list_key=?", (key,))
            c.execute("INSERT OR REPLACE INTO cols(list_key, json) VALUES(?,?)", (key, json.dumps(colmap)))
            c.executemany("INSERT INTO items(list_key, id, fields, created) VALUES(?,?,?,?)",
                          [(key, str(i.get("id")), json.dumps(i.get("fields", {})),
                            i.get("createdDateTime", "")) for i in items])

    def mark_snapshot(self, by: str) -> None:
        with self._c() as c:
            c.execute("INSERT OR REPLACE INTO meta VALUES('taken_at', ?)",
                      (_dt.datetime.now().isoformat(timespec="seconds"),))
            c.execute("INSERT OR REPLACE INTO meta VALUES('taken_by', ?)", (by or "",))

    # ---- list access (Graph-shaped) -----------------------------------------
    def colmap(self, key: str) -> dict:
        with self._c() as c:
            r = c.execute("SELECT json FROM cols WHERE list_key=?", (key,)).fetchone()
        return json.loads(r[0]) if r else {}

    def items(self, key: str) -> list[dict]:
        with self._c() as c:
            rows = c.execute("SELECT id, fields, created FROM items WHERE list_key=?", (key,)).fetchall()
        return [{"id": i, "fields": json.loads(f), "createdDateTime": cr or ""} for i, f, cr in rows]

    def add(self, key: str, fields: dict) -> str:
        iid = "L" + uuid.uuid4().hex[:12]
        with self._c() as c:
            c.execute("INSERT INTO items(list_key, id, fields, created) VALUES(?,?,?,?)",
                      (key, iid, json.dumps(fields), _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds") + "Z"))
        return iid

    def patch(self, key: str, item_id: str, fields: dict) -> None:
        with self._c() as c:
            r = c.execute("SELECT fields FROM items WHERE list_key=? AND id=?", (key, str(item_id))).fetchone()
            if not r:
                return
            cur = json.loads(r[0])
            cur.update(fields)
            c.execute("UPDATE items SET fields=? WHERE list_key=? AND id=?", (json.dumps(cur), key, str(item_id)))

    def delete(self, key: str, item_id: str) -> None:
        with self._c() as c:
            c.execute("DELETE FROM items WHERE list_key=? AND id=?", (key, str(item_id)))
