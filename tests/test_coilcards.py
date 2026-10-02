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

    def __call__(self, server, db, sql, params=None, nonquery=False, timeout=45):
        self.calls.append((server, db, sql, dict(params or {})))
        if self.fail:
            return {"__error__": self.fail}
        nbs = (params or {}).get("nbs")
        if sql.startswith("SELECT * FROM [dbo].[Card]"):
            return {"rows": [self.cards[nbs]] if nbs in self.cards else []}
        if sql.startswith("SELECT COUNT(*)"):
            return {"rows": [{"n": str(self.tracking.get(nbs, 0))}]}
        if sql.startswith("SELECT * FROM [dbo].[CoilTracking]"):
            return {"rows": [{"CoilID": nbs}] * self.tracking.get(nbs, 0)}
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


if __name__ == "__main__":
    unittest.main()
