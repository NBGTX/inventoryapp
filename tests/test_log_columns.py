import unittest

import _env
from _env import FakeSite, make_client

import localstore
import load_central as lc

# Columns exactly as "New list from Excel" creates them: display names map to field_N.
LOG_COLS = {"title": "Title", "division": "field_1", "action": "field_2", "serial": "field_3", "model": "field_4",
            "actor": "field_5", "details": "field_6", "loggedat": "field_7"}


class ActivityLogColumns(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        self.site = FakeSite(self.gc, colmaps={"log": LOG_COLS})
        self.gc.add_log = type(self.gc).add_log.__get__(self.gc)      # real add_log (FakeSite stubs it)

    def test_add_log_writes_internal_column_names(self):
        self.gc.add_log("Sync", "S1", "M", actor="me", details="d")
        sent = [s for s in self.site.sent if s[0] == "POST"][-1][2]["fields"]
        self.assertEqual(sent["field_2"], "Sync")
        self.assertEqual(sent["field_3"], "S1")
        self.assertEqual(sent["field_5"], "me")
        self.assertEqual(sent["field_1"], "nbgw")                      # division stamp
        self.assertIn("field_7", sent)
        self.assertNotIn("Action", sent)                               # the literal names SharePoint rejected

    def test_get_log_reads_internal_column_names_and_filters_division(self):
        self.site.add("log", Title="Sync", field_1="nbgw", field_2="Sync", field_3="S1", field_7="2026-10-01T10:00:00Z", field_6="x")
        self.site.add("log", Title="Other", field_1="nbgtx", field_2="Added", field_3="S2", field_7="2026-10-01T11:00:00Z")
        self.gc._get_all = lambda url: list(self.site.rows["log"])
        rows = self.gc.get_log()
        self.assertEqual([(r["action"], r["serial"], r["details"]) for r in rows], [("Sync", "S1", "x")])

    def test_legacy_lists_with_real_names_still_work(self):
        gc = make_client(central=False)
        site = FakeSite(gc, colmaps={"log": {"action": "Action", "serial": "Serial", "loggedat": "LoggedAt", "title": "Title"}})
        gc.add_log = type(gc).add_log.__get__(gc)
        gc.add_log("Added", "S9")
        sent = [s for s in site.sent if s[0] == "POST"][-1][2]["fields"]
        self.assertEqual((sent["Action"], sent["Serial"]), ("Added", "S9"))

    def test_loader_translates_log_rows_both_ways_and_skips_existing(self):
        store = localstore.LocalStore("nbgw")
        store.replace_list("log", {}, [
            {"id": "1", "fields": {"Title": "Added S1", "Action": "Added", "Serial": "S1", "LoggedAt": "2026-07-15T14:02:00Z"}},
            {"id": "2", "fields": {"Title": "Added S2", "Action": "Added", "Serial": "S2", "LoggedAt": "2026-07-16T09:00:00Z"}}])
        for k in ("new_stock", "in_use", "model_specs"):
            store.replace_list(k, {}, [])
        self.site.add("log", Title="Added S1", field_1="nbgw", field_2="Added", field_3="S1", field_7="2026-07-15T14:02:00Z")
        p = lc.plan(self.gc, store, "nbgw")
        add = p["log"]["add"]
        self.assertEqual(len(add), 1)
        self.assertEqual(add[0]["field_3"], "S2")                      # S1 already loaded (matched via display names)
        self.assertEqual(p["log"]["skip"], 1)


if __name__ == "__main__":
    unittest.main()
