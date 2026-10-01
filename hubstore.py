"""Central hub storage: hub documents as rows in the 'Inventory - Hub Items' SharePoint list.

Replaces the OneDrive-synced JSON files (no locking, last-writer-wins) when the app runs
against the central site. Hub keeps its JSON-document API; only the I/O underneath changes.

Row layout (one list, all divisions):
    Title    "<division>:<kind>:<doc>#<part>"
    Division indexed, the active division id
    Kind     indexed, e.g. "upgrade-list", "hot-spares", "changes", "setups", "blob"
    ItemId   "<doc>#<part>"  (part = 0000, 0001, ... so documents bigger than one text
             column are split into chunks and re-joined on read)
    Payload  plain-text chunk of the JSON (<= CHUNK chars)
    Rev      integer (stored as text) document revision, identical on every part

Setup HTML and other non-JSON files ("blob" kind) are not rows: they are uploaded to the
'Inventory - Hub Files' document library, one folder per division.

Concurrency: every write bumps Rev. A write is rejected (HubConflict) if the stored Rev
changed since THIS Hub instance last read the document, so two people editing the same
document no longer silently overwrite each other. Readers re-read when parts disagree on
Rev (a writer is mid-update). Event-style kinds (changes, feedback, setups) are one row set
per item, so they never conflict.
"""
from __future__ import annotations

import json
import os
import re
import time

CHUNK = 50000       # chars per Payload row (SharePoint plain multi-line text tops out near 63k)
_TTL = 15.0         # seconds a fetched kind is reused (dashboard polls every 45 s)
_BATCH = 20


class HubConflict(Exception):
    """The document changed in SharePoint since this app last read it."""


def _int(v) -> int:
    """SharePoint returns a Number column as 1.0 (float) - accept '1', '1.0', 1, 1.0."""
    try:
        return int(float(str(v).strip() or 0))
    except (TypeError, ValueError):
        return 0


def kind_for_file(stem: str) -> str:
    """nbgw-upgrade-list -> upgrade-list (the division prefix is not part of the kind)."""
    return re.sub(r"^nbgw-", "", stem or "", flags=re.I)


class SharePointHubStore:
    def __init__(self, gc, div_id: str | None = None):
        self.gc = gc
        self._div_id = div_id or gc.division["id"]     # fixed for this Hub: a later division switch cannot redirect its writes
        self._rev: dict = {}       # (kind, doc) -> rev seen at last read/write
        self._cache: dict = {}     # kind -> (t, {doc: (text, rev, rows)})

    def _div(self) -> str:
        return getattr(self, "_div_id", None) or self.gc.division["id"]

    # ------------------------------------------------ REST seam (overridden in tests)
    def _col(self, display: str, key: str = "hub_items") -> str:
        return self.gc._col_map(key).get(display.lower(), display.replace(" ", ""))

    # ---- blobs: files in the Hub Files document library ----------------
    def _blob_url(self, name: str, tail: str = "") -> str:
        from urllib.parse import quote
        from graph import GRAPH
        gc = self.gc
        site = gc._ensure_site()
        lid = gc._list_id("hub_files")
        if not name or "/" in name or "\\" in name or ".." in name:
            raise ValueError(f"Bad file name: {name!r}")
        path = quote(f"{self._div()}/{name}", safe="/")
        return f"{GRAPH}/sites/{site}/lists/{lid}/drive/root:/{path}{tail}"

    def _blob_get(self, name: str):
        from graph import GraphError
        try:
            return self.gc._req("GET", self._blob_url(name, ":/content")).content.decode("utf-8-sig")
        except GraphError as e:
            if "404" in str(e):
                return None
            raise

    def _blob_head(self, name: str) -> bool:
        from graph import GraphError
        try:
            self.gc._req("GET", self._blob_url(name, "?$select=id"))
            return True
        except GraphError as e:
            if "404" in str(e):
                return False
            raise

    def _blob_put(self, name: str, text: str) -> None:
        from graph import GRAPH
        gc = self.gc
        item = gc._req("PUT", self._blob_url(name, ":/content"), data=text.encode("utf-8"),
                       headers={"Content-Type": "application/octet-stream"}).json()
        self._tag_blob(item, "setup-html", name)

    def _tag_blob(self, item: dict, kind: str, name: str) -> None:
        """Best effort: fill the library's Division / Kind / Item Id columns when they exist. The file is already saved and is
        found by its folder + name, so a library without those columns (or any hiccup here) must not fail the save."""
        from graph import GRAPH
        gc = self.gc
        try:
            site = gc._ensure_site()
            lid = gc._list_id("hub_files")
            li = gc._req("GET", f"{GRAPH}/sites/{site}/lists/{lid}/drive/items/{item['id']}/listItem?$select=id").json()["id"]
            gc._req("PATCH", f"{GRAPH}/sites/{site}/lists/{lid}/items/{li}/fields",
                    json={self._col("Division", "hub_files"): self._div(), self._col("Kind", "hub_files"): kind,
                          self._col("Item Id", "hub_files"): name})
        except Exception:
            pass

    def put_bytes(self, name: str, data: bytes, kind: str = "attachment") -> None:
        """Upload a binary file to this division's folder in the Hub Files library."""
        from graph import GRAPH
        gc = self.gc
        item = gc._req("PUT", self._blob_url(name, ":/content"), data=data, headers={"Content-Type": "application/octet-stream"}).json()
        self._tag_blob(item, kind, name)

    def get_bytes(self, name: str):
        from graph import GraphError
        try:
            return self.gc._req("GET", self._blob_url(name, ":/content")).content
        except GraphError as e:
            if "404" in str(e):
                return None
            raise

    def _blob_del(self, name: str) -> None:
        from graph import GraphError
        try:
            self.gc._req("DELETE", self._blob_url(name))
        except GraphError as e:
            if "404" not in str(e):
                raise

    def _fetch_rows(self, kind: str) -> list:
        from graph import GRAPH
        gc = self.gc
        site = gc._ensure_site()
        lid = gc._list_id("hub_items")
        div = self._div().replace("'", "''")
        k = kind.replace("'", "''")
        url = (f"{GRAPH}/sites/{site}/lists/{lid}/items?expand=fields&$top=500"
               f"&$filter=fields/{self._col('Division')} eq '{div}' and fields/{self._col('Kind')} eq '{k}'")
        hdr = {"Prefer": "HonorNonIndexedQueriesWarningMayFailRandomly"}
        rows = []
        while url:
            d = gc._req("GET", url, headers=hdr).json()
            for it in d.get("value", []):
                f = it.get("fields", {}) or {}
                rows.append({"id": it["id"], "item_id": str(f.get(self._col("Item Id")) or ""),
                             "rev": _int(f.get(self._col("Rev"))), "payload": str(f.get(self._col("Payload")) or "")})
            url = d.get("@odata.nextLink")
        return rows

    def _apply(self, ops: list) -> None:
        """ops: ("post", fields) | ("patch", item_id, fields) | ("delete", item_id)."""
        from graph import GRAPH, GraphError
        gc = self.gc
        site = gc._ensure_site()
        lid = gc._list_id("hub_items")
        base = f"/sites/{site}/lists/{lid}/items"
        for i in range(0, len(ops), _BATCH):
            reqs = []
            for n, op in enumerate(ops[i:i + _BATCH]):
                if op[0] == "post":
                    reqs.append({"id": str(n), "method": "POST", "url": base,
                                 "headers": {"Content-Type": "application/json"}, "body": {"fields": op[1]}})
                elif op[0] == "patch":
                    reqs.append({"id": str(n), "method": "PATCH", "url": f"{base}/{op[1]}/fields",
                                 "headers": {"Content-Type": "application/json"}, "body": op[2]})
                else:
                    reqs.append({"id": str(n), "method": "DELETE", "url": f"{base}/{op[1]}"})
            resp = gc._req("POST", f"{GRAPH}/$batch", json={"requests": reqs}).json()
            method = {r["id"]: r["method"] for r in reqs}
            bad = [r for r in resp.get("responses", [])
                   if r.get("status", 500) >= 300 and not (r.get("status") == 404 and method.get(r.get("id")) == "DELETE")]
            if any(r.get("status") == 404 for r in bad):
                raise HubConflict("A hub row was removed by someone else while saving. Reload and try again.")
            if bad:
                raise GraphError(f"Hub write failed ({len(bad)} of {len(reqs)} operations; first status {bad[0].get('status')}).")

    # ------------------------------------------------ reading
    def _docs(self, kind: str, force: bool = False, strict: bool = True) -> dict:
        c = self._cache.get(kind)
        if c and not force and time.monotonic() - c[0] < _TTL:
            return c[1]
        docs: dict = {}
        for _ in range(3):
            by: dict = {}
            for r in self._fetch_rows(kind):
                doc, _, part = r["item_id"].rpartition("#")
                if doc:
                    by.setdefault(doc, []).append((part, r))
            docs, consistent = {}, True
            for doc, parts in by.items():
                parts.sort(key=lambda p: p[0])
                revs = {r["rev"] for _, r in parts}
                consistent = consistent and len(revs) == 1       # mixed revs = a writer is mid-update
                docs[doc] = ("".join(r["payload"] for _, r in parts), max(revs), [r for _, r in parts])
            if consistent:
                break
            time.sleep(0.4)
        else:
            if strict:     # never hand out text stitched from two revisions (it could be corrupt JSON)
                raise HubConflict(f"'{kind}' is being updated by someone else. Try again in a moment.")
        self._cache[kind] = (time.monotonic(), docs)
        return docs

    def read(self, kind: str, doc: str):
        if kind == "blob":
            return self._blob_get(doc)
        e = self._docs(kind).get(doc)
        if e is None:
            self._rev.setdefault((kind, doc), 0)     # we saw it missing: a creator that beats us is a conflict
            return None
        self._rev[(kind, doc)] = e[1]
        return e[0]

    def exists(self, kind: str, doc: str) -> bool:
        if kind == "blob":
            return self._blob_head(doc)
        present = doc in self._docs(kind)
        if not present:
            self._rev.setdefault((kind, doc), 0)
        return present

    def list_docs(self, kind: str) -> list:
        if kind == "blob":
            return []                      # files are fetched by name, never listed
        out = []
        for doc, (text, rev, _rows) in self._docs(kind).items():
            self._rev[(kind, doc)] = rev
            out.append((doc, text))
        return out

    # ------------------------------------------------ writing
    def write(self, kind: str, doc: str, text: str) -> None:
        if kind == "blob":
            self._blob_put(doc, text)
            return
        docs = self._docs(kind, force=True, strict=False)      # a write may repair a half-written document
        e = docs.get(doc)
        cur_rev = e[1] if e else 0
        old_rows = e[2] if e else []
        seen = self._rev.get((kind, doc))
        if seen is not None and cur_rev != seen:
            raise HubConflict(f"'{kind}' was changed by someone else. Reload and try again.")
        new_rev = cur_rev + 1
        chunks = [text[i:i + CHUNK] for i in range(0, len(text), CHUNK)] or [""]
        div = self._div()
        have = {r["item_id"]: r for r in old_rows}
        ops = []
        for i, chunk in enumerate(chunks):
            item_id = f"{doc}#{i:04d}"
            vals = {self._col("Payload"): chunk, self._col("Rev"): str(new_rev)}
            if item_id in have:
                ops.append(("patch", have[item_id]["id"], vals))
            else:
                ops.append(("post", {"Title": f"{div}:{kind}:{item_id}", self._col("Division"): div,
                                     self._col("Kind"): kind, self._col("Item Id"): item_id, **vals}))
        keep = {f"{doc}#{i:04d}" for i in range(len(chunks))}
        ops += [("delete", r["id"]) for iid, r in have.items() if iid not in keep]
        self._apply(ops)
        self._cache.pop(kind, None)
        self._rev[(kind, doc)] = new_rev

    def remove(self, kind: str, doc: str) -> None:
        if kind == "blob":
            self._blob_del(doc)
            return
        e = self._docs(kind, force=True, strict=False).get(doc)
        if e:
            self._apply([("delete", r["id"]) for r in e[2]])
        self._cache.pop(kind, None)
        self._rev.pop((kind, doc), None)


# ---------------------------------------------------- folder import (migration loader)
def scan_folder(logs_dir: str, hub_dir: str):
    """Yield (kind, doc, text) for every hub file: root json -> (kind,'main'); sub-folder json
    -> (folder, stem); other files in the logs root (setup HTML) -> ('blob', filename)."""
    if os.path.isdir(hub_dir):
        for name in sorted(os.listdir(hub_dir)):
            p = os.path.join(hub_dir, name)
            if os.path.isfile(p) and name.lower().endswith(".json"):
                yield kind_for_file(os.path.splitext(name)[0]), "main", _read(p)
            elif os.path.isdir(p):
                for sub in sorted(os.listdir(p)):
                    sp = os.path.join(p, sub)
                    if os.path.isfile(sp) and sub.lower().endswith(".json"):
                        yield name.lower(), os.path.splitext(sub)[0], _read(sp)
    if os.path.isdir(logs_dir):
        for name in sorted(os.listdir(logs_dir)):
            p = os.path.join(logs_dir, name)
            if os.path.isfile(p) and not name.lower().endswith((".tmp", ".json")):
                try:
                    yield "blob", name, _read(p)
                except (OSError, UnicodeDecodeError):
                    continue                       # not a text file: skip


def _read(path: str) -> str:
    with open(path, "r", encoding="utf-8-sig") as f:
        return f.read()


def same_json(a: str, b: str) -> bool:
    try:
        return json.loads(a) == json.loads(b)
    except Exception:
        return a == b
