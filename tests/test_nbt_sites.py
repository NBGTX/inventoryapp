import tempfile
import unittest

import _env                     # noqa: F401
from _env import FakeSite, make_client

import app
import hub as hubmod
from hub import Hub

PNG = "data:image/png;base64," + "A" * 200


def site(i, cat="Security", icon="🔒", **kw):
    return dict({"id": i, "name": i.title(), "url": f"https://{i}.example.com/", "icon": icon, "mode": "browser", "category": cat}, **kw)


class Clean(unittest.TestCase):
    def test_icons_are_emoji_or_small_png_only(self):
        c = app.Api._clean_icon
        self.assertEqual(c("🔑"), "🔑")
        self.assertEqual(c(PNG), PNG)
        for bad in ("", None, "<script>", "x" * 40, "data:image/svg+xml;base64," + "A" * 50, "data:image/png;base64,short", "javascript:alert(1)"):
            self.assertEqual(c(bad), "\U0001F310", repr(bad))

    def test_sites_are_cleaned(self):
        d = app.Api._clean_sites({"categories": [" A ", "a", "B", ""], "pin": 1700, "sites": [
            site("ok", icon=PNG), {"name": "NoUrl", "url": ""}, {"name": "Bad", "url": "ftp://x"}, "junk", site("m", mode="evil")]})
        self.assertEqual(d["categories"], ["A", "B"])
        self.assertEqual([s["id"] for s in d["sites"]], ["ok", "m"])
        self.assertEqual((d["sites"][0]["icon"], d["sites"][1]["mode"]), (PNG, "fullview"))


class Platform(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        FakeSite(self.gc)
        self.gc.sign_in = lambda interactive=False: ""
        self.gc.account_upn, self.gc.account_name = "boss@nucor.com", "Boss"
        self.dir = tempfile.mkdtemp()
        self._orig = hubmod.platform_hub_for
        hubmod.platform_hub_for = lambda gc: Hub(logs_folder=self.dir, division={"id": "_platform", "name": "P", "legacy_data": False, "sites": []})
        self.api = app.Api()
        self.api._gc = self.gc
        self.api._hub = Hub(logs_folder=tempfile.mkdtemp(), division={"id": "nbgw", "name": "W", "legacy_data": True, "sites": []})

    def tearDown(self):
        hubmod.platform_hub_for = self._orig

    def test_old_division_list_is_shown_until_a_platform_list_is_saved(self):
        self.api._hub.save_sites({"categories": ["Old"], "sites": [site("old", cat="Old")], "pin": "1"})
        r = self.api.hub_get_sites()
        self.assertEqual((r["platform"], r["data"]["sites"][0]["id"]), (False, "old"))
        self.assertTrue(self.api.hub_save_sites({"categories": ["New"], "sites": [site("new", cat="New", icon=PNG)]})["ok"])
        r = self.api.hub_get_sites()
        self.assertEqual((r["platform"], [s["id"] for s in r["data"]["sites"]], r["data"]["sites"][0]["icon"]), (True, ["new"], PNG))

    def test_super_admin_changes_everything_others_only_the_custom_category(self):
        base = {"categories": ["Security"], "sites": [site("sec")]}
        self.assertTrue(self.api.hub_save_sites(base)["ok"])
        self.gc.account_upn, self.gc.account_name = "tech@nucor.com", "Tech"
        mine = {"categories": ["Security", "Custom"], "sites": [site("sec"), site("mine", cat="Custom", icon="🚀")]}
        self.assertTrue(self.api.hub_save_sites(mine)["ok"])                                 # self-serve add
        self.assertEqual(len(self.api.hub_get_sites()["data"]["sites"]), 2)
        for evil in ({"categories": ["Security", "Custom"], "sites": [site("sec", icon="💣"), site("mine", cat="Custom")]},   # change a built-in icon
                     {"categories": ["Security", "Custom"], "sites": [site("mine", cat="Custom")]},                           # delete a built-in
                     {"categories": ["Other", "Custom"], "sites": [site("sec"), site("mine", cat="Custom")]}):                # rename categories
            r = self.api.hub_save_sites(evil)
            self.assertFalse(r["ok"], evil)
            self.assertIn("super admin", r["error"])
        self.assertEqual(len(self.api.hub_get_sites()["data"]["sites"]), 2)
        mine["sites"] = [site("sec")]                                                          # removing their own custom site is fine
        self.assertTrue(self.api.hub_save_sites(mine)["ok"])


if __name__ == "__main__":
    unittest.main()
