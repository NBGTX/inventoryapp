import datetime
import tempfile
import unittest

import _env                     # noqa: F401
from _env import FakeSite, make_client

import app
from hub import Hub


class DeviceDates(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        FakeSite(self.gc)
        self.gc.sign_in = lambda interactive=False: ""
        self.gc.account_upn, self.gc.account_name = "boss@nucor.com", "Boss"
        self.api = app.Api()
        self.api._gc = self.gc
        self.api._hub = Hub(logs_folder=tempfile.mkdtemp(), division={"id": "nbgw", "name": "W", "legacy_data": True, "sites": []})
        self.today = datetime.date.today().isoformat()

    def get(self):
        return self.api.device_dates_get()["data"]

    def test_set_deploy_and_manufacture_dates_per_serial_case_insensitive(self):
        r = self.api.device_dates_set(["ABC123", "xyz"], "2026-09-01", "2025-01-15")
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.get()["abc123"], {"deploy": "2026-09-01", "mfg": "2025-01-15"})
        self.assertEqual(set(self.get()), {"abc123", "xyz"})

    def test_none_leaves_alone_and_empty_clears(self):
        self.api.device_dates_set(["S1"], "2026-09-01", "2025-01-15")
        self.api.device_dates_set(["S1"], None, "2025-02-01")                       # only mfg changes
        self.assertEqual(self.get()["s1"], {"deploy": "2026-09-01", "mfg": "2025-02-01"})
        self.api.device_dates_set(["S1"], "", None)                                  # clear deploy
        self.assertEqual(self.get()["s1"], {"mfg": "2025-02-01"})
        self.api.device_dates_set(["S1"], None, "")                                  # nothing left: the entry goes away
        self.assertNotIn("s1", self.get())

    def test_rejects_bad_future_and_empty_requests(self):
        for kw in ({"deploy": "31/12/2026"}, {"deploy": "2999-01-01"}, {"mfg": "1980-01-01"}, {"mfg": "nope"}):
            r = self.api.device_dates_set(["S1"], kw.get("deploy"), kw.get("mfg"))
            self.assertFalse(r["ok"], kw)
        self.assertFalse(self.api.device_dates_set([], "2026-09-01")["ok"])
        self.assertFalse(self.api.device_dates_set(["S1"])["ok"])                    # nothing to change
        self.assertEqual(self.get(), {})
        self.assertTrue(self.api.device_dates_set("S1", self.today)["ok"])           # a single serial as a string, today is fine


if __name__ == "__main__":
    unittest.main()
