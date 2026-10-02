import json
import os
import unittest

import _env
from _env import make_client

import app
import coilcards
import settings_catalog as sc
import sqltools


class FakeSql:
    """Stands in for sqltools.run: records statements, answers from a tiny in-memory 'database'."""

    def __init__(self, cards=None, tracking=None, fail=None):
        self.cards = cards if cards is not None else {"141487": {"NBSNumber": "141487", "PartNumber": "P1", "HeatNumber": "H1"}}
        self.tracking = tracking if tracking is not None else {"141487": 3}
        self.fail = fail
        self.calls = []
        self.columns = {}
        self.restored = None

    def __call__(self, server, db, sql, params=None, nonquery=False, timeout=45, exact=False):
        self.calls.append((server, db, sql, dict(params or {})))
        if self.fail:
            return {"__error__": self.fail}
        nbs = (params or {}).get("nbs")
        if sql.startswith("SELECT * FROM [dbo].[Card]"):
            return {"rows": [self.cards[nbs]] if nbs in self.cards else []}
        if sql.startswith("SELECT COUNT(*)") and "FROM [dbo].[Card] " in sql:
            return {"rows": [{"n": "1" if nbs in self.cards else "0"}]}
        if sql.startswith("SELECT COUNT(*)"):
            return {"rows": [{"n": str(self.tracking.get(nbs, 0))}]}
        if sql.startswith("SELECT * FROM [dbo].[CoilTracking]"):
            return {"rows": [{"CoilID": nbs}] * self.tracking.get(nbs, 0)}
        if sql.startswith("SELECT c.name, c.is_identity"):
            return {"rows": self.columns.get(params["t"], [])}
        if "INSERT INTO" in sql:
            n = sql.count("INSERT INTO [dbo].[CoilTracking]")
            self.restored = sql
            return {"rows": [{"tracking": str(n), "cards": "1"}]}
        if sql.startswith("SET XACT_ABORT ON"):
            t = self.tracking.pop(nbs, 0)
            c = 1 if self.cards.pop(nbs, None) is not None else 0
            return {"rows": [{"tracking": str(t), "cards": str(c)}]}
        raise AssertionError("unexpected SQL: " + sql)


class FakeHub:
    def __init__(self):
        self.changes = []
        self.files = {}
        self.put_error = None
        self.corrupt = False

    def _change(self, kind, text):
        self.changes.append((kind, text))

    def put_attachment(self, name, data):
        if self.put_error:
            raise RuntimeError(self.put_error)
        self.files[name] = data

    def list_attachments(self, prefix=""):
        return [{"name": n, "size": len(d), "modified": ""} for n, d in sorted(self.files.items(), reverse=True) if n.startswith(prefix)]

    def get_attachment(self, name):
        d = self.files.get(name)
        return d + b"x" if (d is not None and self.corrupt) else d


class CoilCardTests(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"timesheet_sql_server": "SRV1"})
        self.api = app.Api()
        self.api._gc = self.gc
        self.api._hub = FakeHub()
        self.sql = FakeSql()
        self._orig = sqltools.run
        sqltools.run = self.sql

    def tearDown(self):
        sqltools.run = self._orig

    def test_find_is_read_only_and_counts_tracking(self):
        r = self.api.coil_card_find("141487")
        self.assertTrue(r["ok"] and r["found"])
        self.assertEqual(r["tracking_rows"], 3)
        self.assertEqual(self.sql.calls[0][0:2], ("SRV1", "CoilCard"))
        self.assertFalse(any("DELETE" in c[2] for c in self.sql.calls))

    def test_find_missing_card(self):
        self.assertEqual(self.api.coil_card_find("999")["found"], False)

    def test_dry_run_is_default_and_deletes_nothing(self):
        r = self.api.coil_card_delete("141487", "", False)
        self.assertTrue(r["ok"])
        self.assertIn("141487", self.sql.cards)
        self.assertEqual(self.api._hub.changes, [])

    def test_commit_needs_exact_confirm(self):
        r = self.api.coil_card_delete("141487", "14148", True)
        self.assertFalse(r["ok"])
        self.assertIn("141487", self.sql.cards)

    def test_commit_deletes_tracking_before_card_in_one_batch_and_backs_up(self):
        r = self.api.coil_card_delete("141487", "141487", True)
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["cards"], r["tracking"]), (1, 3))
        batch = [c[2] for c in self.sql.calls if c[2].startswith("SET XACT_ABORT ON")]
        self.assertEqual(len(batch), 1)
        sql = batch[0]
        self.assertLess(sql.index("[CoilTracking]"), sql.index("DELETE FROM [dbo].[Card]"))
        self.assertIn("ROLLBACK", sql)
        self.assertNotIn("141487", sql)                      # value is a parameter, never concatenated
        saved = json.loads(self.api._hub.files[r["backup"]].decode("utf-8"))   # backup went to the hub library
        self.assertEqual(saved["card"]["PartNumber"], "P1")
        self.assertEqual(len(saved["tracking"]), 3)
        self.assertEqual(len(self.api._hub.changes), 1)      # one audit entry per run
        self.assertIn("141487", self.api._hub.changes[0][1])

    def test_failed_backup_upload_deletes_nothing(self):
        self.api._hub.put_error = "SharePoint down"
        r = self.api.coil_card_delete("141487", "141487", True)
        self.assertFalse(r["ok"])
        self.assertIn("141487", self.sql.cards)
        self.assertFalse(any(c[2].startswith("SET XACT_ABORT") for c in self.sql.calls))
        self.assertEqual(self.api._hub.changes, [])

    def test_unverifiable_backup_deletes_nothing(self):
        self.api._hub.corrupt = True
        r = self.api.coil_card_delete("141487", "141487", True)
        self.assertFalse(r["ok"])
        self.assertIn("141487", self.sql.cards)
        self.assertFalse(any(c[2].startswith("SET XACT_ABORT") for c in self.sql.calls))

    def test_unknown_card_not_deleted(self):
        r = self.api.coil_card_delete("999", "999", True)
        self.assertFalse(r["ok"])
        self.assertFalse(any(c[2].startswith("SET XACT_ABORT") for c in self.sql.calls))

    def test_blocked_in_local_mode(self):
        self.gc.data_mode = "local"
        r = self.api.coil_card_delete("141487", "141487", True)
        self.assertFalse(r["ok"])
        self.assertIn("Local data mode", r["error"])
        self.assertIn("141487", self.sql.cards)
        self.gc.data_mode = "live"

    def test_sql_error_is_returned_not_raised(self):
        self.sql.fail = "login failed"
        self.assertFalse(self.api.coil_card_find("141487")["ok"])
        self.assertFalse(self.api.coil_card_delete("141487", "141487", True)["ok"])

    def test_no_server_for_division(self):
        gc = make_client()
        gc.cfg["timesheet_sql_server"] = ""
        self.api._gc = gc
        r = self.api.coil_card_find("141487")
        self.assertFalse(r["ok"])

    def test_bad_card_number_rejected(self):
        for bad in ("", "1; DROP TABLE Card", "a b"):
            self.assertFalse(self.api.coil_card_find(bad)["ok"])

    def test_names_come_from_settings_and_are_validated(self):
        self.gc._base_cfg["coilcard_db"] = "OtherDb"
        self.gc._base_cfg["coilcard_card_table"] = "dbo.Cards"
        c = coilcards.conf(self.gc)
        self.assertEqual((c["coilcard_db"], c["card"]), ("OtherDb", "[dbo].[Cards]"))
        self.gc._base_cfg["coilcard_db"] = "x; DROP"
        with self.assertRaises(ValueError):
            coilcards.conf(self.gc)

    def test_catalog_validation(self):
        self.assertEqual(sc.check_value("coilcard_db", " CoilCard "), "CoilCard")
        self.assertEqual(sc.check_value("coilcard_card_table", "dbo.Card"), "dbo.Card")
        self.assertEqual(sc.check_value("coilcard_db", ""), "")
        with self.assertRaises(ValueError):
            sc.check_value("coilcard_card_table", "dbo.Card; --")


CARD_COLS = [{"name": "NBSNumber", "is_identity": "0", "is_computed": "0", "typ": "varchar"},
             {"name": "PartNumber", "is_identity": "0", "is_computed": "0", "typ": "varchar"},
             {"name": "Comment", "is_identity": "0", "is_computed": "0", "typ": "varchar"},
             {"name": "CardDate", "is_identity": "0", "is_computed": "0", "typ": "smalldatetime"},
             {"name": "RowVer", "is_identity": "0", "is_computed": "0", "typ": "timestamp"}]
TRACK_COLS = [{"name": "TrackID", "is_identity": "1", "is_computed": "0", "typ": "int"},
              {"name": "CoilID", "is_identity": "0", "is_computed": "0", "typ": "varchar"},
              {"name": "Blob", "is_identity": "0", "is_computed": "0", "typ": "varbinary"},
              {"name": "Calc", "is_identity": "0", "is_computed": "1", "typ": "int"}]


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"timesheet_sql_server": "SRV1"})
        self.api = app.Api()
        self.api._gc = self.gc
        self.hub = FakeHub()
        self.api._hub = self.hub
        self.sql = FakeSql(cards={}, tracking={})
        self.sql.columns = {"[dbo].[Card]": CARD_COLS, "[dbo].[CoilTracking]": TRACK_COLS}
        self._orig = sqltools.run
        sqltools.run = self.sql
        self.name = "coilcard-backup-141487-20261002-084200.json"
        self.put({"format": 2, "nbs": "141487",
                  "card": {"NBSNumber": "141487", "PartNumber": "O'Brien", "Comment": None,
                           "CardDate": "2026-10-02T08:42:00.000", "RowVer": "0x00AB"},
                  "tracking": [{"TrackID": "7", "CoilID": "141487", "Blob": "0x0A0B", "Calc": "5"},
                               {"TrackID": "8", "CoilID": "141487", "Blob": None, "Calc": "6"}]})

    def tearDown(self):
        sqltools.run = self._orig

    def put(self, data, name=None):
        self.hub.files[name or self.name] = json.dumps(data).encode("utf-8")

    def test_dry_run_changes_nothing(self):
        r = self.api.coil_card_restore(self.name, "", False)
        self.assertTrue(r["ok"] and r["can_restore"], r)
        self.assertEqual((r["nbs"], r["tracking_rows"]), ("141487", 2))
        self.assertIsNone(self.sql.restored)

    def test_commit_needs_exact_confirm(self):
        self.assertFalse(self.api.coil_card_restore(self.name, "1414", True)["ok"])
        self.assertIsNone(self.sql.restored)

    def test_commit_restores_in_one_batch_with_exact_values(self):
        r = self.api.coil_card_restore(self.name, "141487", True)
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["cards"], r["tracking"]), (1, 2))
        sql = self.sql.restored
        self.assertLess(sql.index("INSERT INTO [dbo].[Card]"), sql.index("INSERT INTO [dbo].[CoilTracking]"))
        self.assertIn("N'O''Brien'", sql)                       # quote doubled
        self.assertIn("[Comment]", sql)
        self.assertIn("NULL", sql)                              # NULL kept, not ''
        self.assertIn("0x0A0B", sql)                            # binary literal
        self.assertNotIn("RowVer", sql)                         # timestamp skipped
        self.assertNotIn("Calc", sql)                           # computed skipped
        self.assertIn("SET IDENTITY_INSERT [dbo].[CoilTracking] ON", sql)
        self.assertIn("SET IDENTITY_INSERT [dbo].[CoilTracking] OFF", sql)
        self.assertNotIn("IDENTITY_INSERT [dbo].[Card]", sql)
        self.assertIn("THROW", sql)
        self.assertTrue(sql.rstrip().endswith("SELECT @t AS tracking, @r AS cards;"))
        self.assertEqual(len(self.hub.changes), 1)
        self.assertEqual(self.hub.changes[0][0], "Coil card restored")

    def test_refuses_when_card_exists(self):
        self.sql.cards["141487"] = {"NBSNumber": "141487"}
        r = self.api.coil_card_restore(self.name, "", False)
        self.assertTrue(r["ok"] and r["card_exists"] and not r["can_restore"])
        r = self.api.coil_card_restore(self.name, "141487", True)
        self.assertFalse(r["ok"])
        self.assertIsNone(self.sql.restored)

    def test_refuses_when_tracking_rows_exist(self):
        self.sql.tracking["141487"] = 1
        r = self.api.coil_card_restore(self.name, "141487", True)
        self.assertFalse(r["ok"])
        self.assertIsNone(self.sql.restored)

    def test_blocked_in_local_mode(self):
        self.gc.data_mode = "local"
        r = self.api.coil_card_restore(self.name, "141487", True)
        self.assertIn("Local data mode", r["error"])
        self.assertIsNone(self.sql.restored)
        self.gc.data_mode = "live"

    def test_bad_names_and_files_rejected(self):
        for bad in ("../x.json", "other.json", "coilcard-backup-1/../../x.json", ""):
            self.assertFalse(self.api.coil_card_restore(bad, "", False)["ok"])
        self.assertFalse(self.api.coil_card_restore("coilcard-backup-9-20260101-000000.json", "", False)["ok"])
        old = "coilcard-backup-5-20260101-000000.json"
        self.put({"card": {"NBSNumber": "5"}, "tracking": []}, old)
        self.assertIn("older version", self.api.coil_card_restore(old, "", False)["error"])
        bad = "coilcard-backup-5-20260101-000001.json"
        self.put({"format": 2, "card": {"NBSNumber": "5"}, "tracking": [{"CoilID": "6"}]}, bad)
        self.assertIn("inconsistent", self.api.coil_card_restore(bad, "", False)["error"])

    def test_unknown_column_aborts_before_any_write(self):
        d = json.loads(self.hub.files[self.name])
        d["card"]["Gone"] = "x"
        self.put(d)
        r = self.api.coil_card_restore(self.name, "141487", True)
        self.assertFalse(r["ok"])
        self.assertIn("Gone", r["error"])
        self.assertIsNone(self.sql.restored)

    def test_list_backups(self):
        self.put({"format": 2}, "coilcard-backup-200-20260102-030405.json")
        self.hub.files["something-else.png"] = b"x"
        r = self.api.coil_card_backups()
        self.assertTrue(r["ok"])
        self.assertEqual([(b["nbs"], b["stamp"]) for b in r["backups"]],
                         [("200", "20260102-030405"), ("141487", "20261002-084200")])

    def test_delete_writes_a_backup_the_restore_accepts(self):
        self.sql.cards = {"9": {"NBSNumber": "9", "PartNumber": "P", "Comment": None}}
        self.sql.tracking = {"9": 1}
        r = self.api.coil_card_delete("9", "9", True)
        self.assertTrue(r["ok"], r)
        saved = json.loads(self.hub.files[r["backup"]])
        self.assertEqual(saved["format"], 2)
        self.assertIsNone(saved["card"]["Comment"])
        self.assertEqual(saved["nbs"], "9")
        plan = self.api.coil_card_restore(r["backup"], "", False)
        self.assertTrue(plan["ok"] and plan["can_restore"], plan)


class HubFileListing(unittest.TestCase):
    def test_local_hub_lists_by_prefix_newest_first(self):
        import tempfile
        import hub as hubmod
        div = {"id": "nbgw", "name": "W", "legacy_data": False, "sites": []}
        h = hubmod.Hub(logs_folder=tempfile.mkdtemp(), division=div)
        for n in ("coilcard-backup-1-20260101-000000.json", "coilcard-backup-2-20260102-000000.json", "other.bin"):
            h.put_attachment(n, b"{}")
        got = [x["name"] for x in h.list_attachments("coilcard-backup-")]
        self.assertEqual(got, ["coilcard-backup-2-20260102-000000.json", "coilcard-backup-1-20260101-000000.json"])
        empty = hubmod.Hub(logs_folder=tempfile.mkdtemp(), division=dict(div, id="x"))
        self.assertEqual(empty.list_attachments("a"), [])

    def test_store_lists_folder_and_tolerates_missing_folder(self):
        import types
        import hubstore
        from graph import GraphError
        seen = []
        gc = types.SimpleNamespace(division={"id": "nbgw"}, _ensure_site=lambda: "S", _list_id=lambda k: "L")

        def fetch(url):
            seen.append(url)
            return [{"name": "coilcard-backup-1-a.json", "size": 5, "lastModifiedDateTime": "t"},
                    {"name": "x.html", "size": 1}]
        gc._get_all = fetch
        store = hubstore.SharePointHubStore.__new__(hubstore.SharePointHubStore)
        store.gc, store._div_id = gc, None
        self.assertEqual([x["name"] for x in store.list_names("coilcard-backup-")], ["coilcard-backup-1-a.json"])
        self.assertIn("root:/nbgw:/children", seen[0])

        def boom(url):
            raise GraphError("404 not found")
        gc._get_all = boom
        self.assertEqual(store.list_names("coilcard-backup-"), [])


if __name__ == "__main__":
    unittest.main()
