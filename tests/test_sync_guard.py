import unittest

import _env
from _env import FakeSite, make_client

import graph
import schema
import sync


def cols_for(key, bad=None):
    """Graph column definitions matching schema.SPEC[key], with optional overrides {display: 'number'|...}."""
    out = []
    for disp, want in schema.SPEC[key].items():
        c = {"displayName": disp, "indexed": want.endswith("*")}
        t = (bad or {}).get(disp)
        if t == "number":
            c["number"] = {}
        elif want.rstrip("*") == "note":
            c["text"] = {"allowMultipleLines": True}
        else:
            c["text"] = {}
        out.append(c)
    return out


class Schema(unittest.TestCase):
    def test_flags_number_columns_missing_columns_and_missing_index(self):
        cols = cols_for("in_use", bad={"OS Install Date": "number", "Last Sign In": "number"})
        cols = [c for c in cols if c["displayName"] != "MFA"]
        for c in cols:
            if c["displayName"] == "Division":
                c["indexed"] = False
        notes = schema.list_problems(cols, schema.SPEC["in_use"])
        text = " | ".join(notes)
        self.assertIn("'OS Install Date' is number", text)
        self.assertIn("'Last Sign In' is number", text)
        self.assertIn("missing column 'MFA'", text)
        self.assertIn("'Division' is not indexed", text)

    def test_clean_list_has_no_problems(self):
        for key in schema.SPEC:
            self.assertEqual(schema.list_problems(cols_for(key), schema.SPEC[key]), [], key)

    def test_rev_and_enabled_accept_text_number_or_boolean(self):
        cols = cols_for("hub_items", bad={"Rev": "number"})
        self.assertEqual(schema.list_problems(cols, schema.SPEC["hub_items"]), [])


class SyncPreflight(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        self.site = FakeSite(self.gc)
        self.calls = []
        self.gc.get_intune_category_devices = lambda: [{"serial": "S1", "device_name": "D1"}]
        self.gc.add_in_use = lambda d: self.calls.append(d)

    def test_commit_refused_when_a_column_has_the_wrong_type(self):
        def get_all(url):
            key = url.split("/lists/L")[1].split("/")[0]
            return cols_for(key, bad={"OS Install Date": "number"} if key == "in_use" else None)
        self.gc._get_all = get_all
        r = sync.run_sync(self.gc, commit=True)
        self.assertEqual(self.calls, [])                       # nothing written
        self.assertEqual((r["added"], r["count"]), (0, 0))
        self.assertIn("Central lists need fixing", r["errors"][0])
        self.assertIn("OS Install Date", r["errors"][0])

    def test_commit_proceeds_when_columns_are_right(self):
        self.gc._get_all = lambda url: cols_for(url.split("/lists/L")[1].split("/")[0])
        r = sync.run_sync(self.gc, commit=True)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(r["added"], 1)

    def test_dry_run_skips_the_preflight(self):
        self.gc._get_all = lambda url: self.fail("schema fetched in a dry run")
        r = sync.run_sync(self.gc, commit=False)
        self.assertEqual(r["count"], 1)


class FailFast(unittest.TestCase):
    def test_stops_after_consecutive_write_failures(self):
        gc = make_client(central=False)
        attempts = []

        def boom(d):
            attempts.append(d["serial"])
            raise graph.GraphError("400 badArgument")
        gc.get_intune_category_devices = lambda: [{"serial": f"S{i}"} for i in range(50)]
        gc._items_raw = lambda k: []
        gc.add_in_use = boom
        gc.add_log = lambda *a, **k: None
        r = sync.run_sync(gc, commit=True)
        self.assertEqual(len(attempts), sync._MAX_FAIL_STREAK)
        self.assertEqual(r["added"], 0)
        self.assertTrue(any("Stopped after" in e for e in r["errors"]))
        self.assertLess(len(r["errors"]), 10)

    def test_streak_resets_on_success(self):
        gc = make_client(central=False)
        n = {"i": 0}
        done = []

        def flaky(d):
            n["i"] += 1
            if n["i"] % 2:                       # every other write fails: never 5 in a row
                raise graph.GraphError("400")
            done.append(d["serial"])
        gc.get_intune_category_devices = lambda: [{"serial": f"S{i}"} for i in range(20)]
        gc._items_raw = lambda k: []
        gc.add_in_use = flaky
        gc.add_log = lambda *a, **k: None
        r = sync.run_sync(gc, commit=True)
        self.assertEqual(len(done), 10)
        self.assertFalse(any("Stopped after" in e for e in r["errors"]))


if __name__ == "__main__":
    unittest.main()
