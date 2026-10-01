import os
import unittest

import _env
from _env import FakeSite, make_client

import app
import graph
import localstore


class MasterSettings(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        self.site = FakeSite(self.gc)
        self.site.add("master_settings", Title="lenovo_client_id", Value="SECRET123", Secret="Yes", Description="d")
        self.site.add("master_settings", Title="super_admins", Value="boss@nucor.com; me@nucor.com", Secret="No")
        self.site.add("master_settings", Title="EXAMPLE-DELETE", Value="x")
        self.api = app.Api()
        self.api._gc = self.gc
        self.gc.account_upn = "me@nucor.com"

    def test_master_wins_then_config_fallback(self):
        self.assertEqual(self.gc.get_setting("lenovo_client_id"), "SECRET123")
        self.site.rows["master_settings"][0]["fields"]["Value"] = ""
        self.gc._master_cache = None
        self.gc._base_cfg["lenovo_client_id"] = "FALLBACK"
        self.assertEqual(self.gc.get_setting("lenovo_client_id"), "FALLBACK")

    def test_super_admin_from_master_row_and_case_insensitive(self):
        self.assertTrue(self.gc.is_super_admin())
        self.gc.account_upn = "ME@Nucor.com"
        self.assertTrue(self.gc.is_super_admin())
        self.gc.account_upn = "nobody@nucor.com"
        self.assertFalse(self.gc.is_super_admin())

    def test_api_masks_secrets_and_hides_from_non_admin(self):
        r = self.api.get_master_settings()
        self.assertTrue(r["super_admin"])
        self.assertNotIn("SECRET123", str(r))
        self.assertEqual([x["key"] for x in r["settings"]], ["lenovo_client_id", "super_admins"])
        self.gc.account_upn = "nobody@nucor.com"
        self.assertEqual(self.api.get_master_settings(), {"ok": True, "super_admin": False, "settings": []})
        self.assertFalse(self.api.set_master_setting("k", "v")["ok"])

    def test_set_setting_patch_vs_post_and_value_not_logged(self):
        self.assertTrue(self.api.set_master_setting("lenovo_client_id", "NEWVAL", True, "d")["ok"])
        self.assertEqual(self.site.sent[0][0], "PATCH")
        self.assertTrue(self.api.set_master_setting("brand_new", "v", False, "")["ok"])
        self.assertEqual([s for s in self.site.sent if s[0] == "POST"][-1][2]["fields"]["Title"], "brand_new")
        logs = [s for s in self.site.sent if s[0] == "LOG"]
        self.assertTrue(logs)
        self.assertNotIn("NEWVAL", str(logs))

    def test_blocked_in_local_mode_and_without_central(self):
        self.gc.data_mode = "local"
        self.assertIn("Local data mode", self.api.set_master_setting("k", "v")["error"])
        gc2 = make_client(central=False)
        self.assertEqual(gc2.master_settings(), {})


class LocalMode(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(central=False)
        self.gc._store = None
        self.store = self.gc._ls()
        cols = {"manufacturer": "Manufacturer", "model": "Model", "site tag": "Site_x0020_Tag", "title": "Title"}
        self.store.replace_list("new_stock", cols, [
            {"id": "1", "fields": {"Title": "SN1", "Manufacturer": "Dell", "Model": "L5540", "Site_x0020_Tag": "LTR"}}])
        self.store.replace_list("in_use", cols, [])
        self.store.mark_snapshot("tester")
        self.api = app.Api()
        self.api._gc = self.gc

    def tearDown(self):
        self.gc.data_mode = "live"

    def test_no_snapshot_blocks_local(self):
        gc = make_client(central=False)
        gc.set_division("nbgw")
        fresh = localstore.LocalStore("nobody")
        self.assertFalse(fresh.has_snapshot())

    def test_local_crud_never_calls_network(self):
        self.gc.set_data_mode("local")
        self.gc._req = lambda *a, **k: self.fail("network call in local mode")
        self.assertEqual([r["serial"] for r in self.gc.get_new_stock()], ["SN1"])
        self.gc.add_new_stock({"serial": "SN2", "manufacturer": "HP", "model": "G10", "site_tag": "BRI"})
        self.gc.update_item("new_stock", "1", {"model": "L5540-X"})
        rows = {r["serial"]: r["model"] for r in self.gc.get_new_stock()}
        self.assertEqual(rows, {"SN1": "L5540-X", "SN2": "G10"})
        self.gc.delete_item("new_stock", "1")
        self.assertEqual([r["serial"] for r in self.gc.get_new_stock()], ["SN2"])
        self.gc.add_log("Added", "SN2", "G10", actor="t", details="d")
        self.assertEqual(self.gc.get_log()[0]["serial"], "SN2")

    def test_timesheet_unlock_blocked_in_local_mode(self):
        self.gc.set_data_mode("local")
        r = self.api.ts_unlock("1", 2026, 1)
        self.assertFalse(r["ok"])
        self.assertIn("Local data mode", r["error"])

    def test_snapshot_hub_copies_folder(self):
        import tempfile
        src = tempfile.mkdtemp()
        os.makedirs(os.path.join(src, "_EndpointHub"))
        with open(os.path.join(src, "_EndpointHub", "nbgw-x.json"), "w") as f:
            f.write("{}")
        import hub
        orig = hub.Hub

        class H(orig):
            def __init__(self, *a, **k):
                super().__init__(logs_folder=src, division=k.get("division"))
        hub.Hub = H
        try:
            r = self.gc.snapshot_hub()
        finally:
            hub.Hub = orig
        self.assertEqual(r["files"], 1)


if __name__ == "__main__":
    unittest.main()
