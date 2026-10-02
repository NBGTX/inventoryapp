import tempfile
import unittest

import _env                     # noqa: F401
from _env import FakeSite, make_client

import app
import hub as hubmod
from hub import Hub


class Auto(unittest.TestCase):
    def test_clean_clamps_and_defaults(self):
        c = app.Api._clean_sw_auto
        self.assertEqual(c(None), {"top": 10, "min_pct": 0, "min_people": 1})
        self.assertEqual(c({"top": "7", "min_pct": 55, "min_people": 3}), {"top": 7, "min_pct": 55, "min_people": 3})
        self.assertEqual(c({"top": -4, "min_pct": 900, "min_people": 0}), {"top": 0, "min_pct": 100, "min_people": 1})
        self.assertEqual(c({"top": "abc"})["top"], 10)


class Save(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        FakeSite(self.gc)
        self.gc.sign_in = lambda interactive=False: ""
        self.gc.account_upn, self.gc.account_name = "boss@nucor.com", "Boss"
        self.dir = tempfile.mkdtemp()
        self.api = app.Api()
        self.api._gc = self.gc
        self.api._hub = Hub(logs_folder=self.dir, division={"id": "nbgw", "name": "W", "legacy_data": True, "sites": []})

    def rules(self):
        return self.api._hub.get_software_rules() or {}

    def test_auto_is_saved_cleaned_and_kept_when_only_rules_change(self):
        rule = {"app": "X", "scope": "Dept", "required": True}
        r = self.api.software_save_rules({"rules": [rule], "auto": {"top": 5, "min_pct": 60, "min_people": 4}})
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.rules()["auto"], {"top": 5, "min_pct": 60, "min_people": 4})
        self.assertTrue(self.api.software_save_rules({"rules": []})["ok"])               # an ordinary tick keeps the automatic settings
        self.assertEqual(self.rules()["auto"]["top"], 5)
        self.assertEqual(self.rules()["rules"], [])

    def test_only_admins_change_the_automatic_rule(self):
        self.gc.account_upn = "tech@nucor.com"
        r = self.api.software_save_rules({"rules": [], "auto": {"top": 3}})
        self.assertFalse(r["ok"])
        self.assertIn("division admins", r["error"])
        self.assertTrue(self.api.software_save_rules({"rules": [{"app": "A", "scope": "D", "required": True}]})["ok"])   # manual rules stay open to everyone
        self.assertTrue(self.api.software_save_rules({"rules": [], "auto": {"top": 10}})["ok"])     # unchanged auto is not a change


if __name__ == "__main__":
    unittest.main()
