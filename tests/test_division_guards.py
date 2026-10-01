import unittest

import _env
from _env import make_client

import app
import divisions


class DivisionGuards(unittest.TestCase):
    def setUp(self):
        self.api = app.Api()

    def test_timesheet_never_falls_back_to_another_divisions_server(self):
        gc = make_client(central=False)
        gc.registry.append({"id": "nbgtx", "name": "TX", "company_name": "NBG - Terrell", "sites": [], "lists": {},
                            "legacy_data": False, "sql_server": ""})
        gc.set_division("nbgtx")
        self.api._gc = gc
        with self.assertRaises(RuntimeError):
            self.api._ts_server()
        r = self.api.ts_weeks("123")
        self.assertFalse(r["ok"])
        self.assertIn("not configured", r["error"])

    def test_timesheet_uses_the_active_divisions_server(self):
        gc = make_client(central=False)
        self.api._gc = gc
        self.assertEqual(self.api._ts_server(), "BGBRISQL07")

    def test_public_division_exposes_ad_domain_and_timesheet_flag(self):
        d = divisions.load_registry({})[0]
        p = divisions.public(d)
        self.assertEqual(p["ad_domain"], "bg.nucorsteel.local")
        self.assertTrue(p["has_timesheet"])
        d2 = dict(d, sql_server="", ad_domain="")
        self.assertFalse(divisions.public(d2)["has_timesheet"])

    def test_locate_devices_without_ad_domain_reports_error_not_nbgw_domain(self):
        gc = make_client(central=False)
        gc.registry.append({"id": "nbgtx", "name": "TX", "company_name": "x", "sites": [], "lists": {},
                            "legacy_data": False, "ad_domain": ""})
        gc.set_division("nbgtx")
        gc.cfg["ad_domain"] = ""
        self.api._gc = gc
        gc.intune_lastsync_map = lambda: {}
        gc.entra_device_map = lambda h: {}
        gc.sign_in = lambda interactive=False: "t"
        r = self.api.locate_devices([{"serial": "S1", "hostname": "H1"}])
        self.assertTrue(r["ok"])
        self.assertEqual(r["ad_domain"], "")
        self.assertIn("No AD domain", r["ad_error"])


if __name__ == "__main__":
    unittest.main()
