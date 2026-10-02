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


class SyncStampsDeployDate(unittest.TestCase):
    def setUp(self):
        self.hub = Hub(logs_folder=tempfile.mkdtemp(), division={"id": "nbgw", "name": "W", "legacy_data": True, "sites": []})

    def dates(self):
        return (self.hub.get_named("device-dates") or {}).get("dates", {})

    def test_stamps_moved_devices_but_never_overwrites_a_date_a_person_set(self):
        import sync
        self.hub.put_named("device-dates", {"dates": {"s2": {"deploy": "2026-01-05", "mfg": "2024-12-01"}}})
        n = sync.record_deploy_dates(None, ["S1", "S2", " ", "s3"], hub=self.hub, today="2026-10-02")
        self.assertEqual(n, 2)
        d = self.dates()
        self.assertEqual(d["s1"], {"deploy": "2026-10-02"})
        self.assertEqual(d["s2"], {"deploy": "2026-01-05", "mfg": "2024-12-01"})        # untouched
        self.assertEqual(d["s3"]["deploy"], "2026-10-02")
        self.assertEqual(sync.record_deploy_dates(None, ["S1"], hub=self.hub, today="2026-10-03"), 0)   # already has one

    def test_run_sync_records_only_devices_that_came_from_stock(self):
        import sync
        from _env import make_client
        gc = make_client()
        gc.get_intune_category_devices = lambda: [{"serial": "FROMSTOCK", "device_name": "D1"}, {"serial": "BRANDNEW", "device_name": "D2"}]
        gc._items_raw = lambda kind: {"new_stock": [{"id": "9", "fields": {"Title": "FromStock"}}]}.get(kind, [])
        gc.add_in_use = lambda d: None
        gc.delete_item = lambda *a, **k: None
        gc.add_log = lambda *a, **k: None
        gc._get_all = lambda url: []
        gc._central = False
        seen = []
        orig, orig_q = sync.record_deploy_dates, sync.queue_upgrades
        sync.record_deploy_dates = lambda g, serials, **k: seen.append(list(serials))
        sync.queue_upgrades = lambda g, hub=None: 0
        try:
            r = sync.run_sync(gc, commit=True)
        finally:
            sync.record_deploy_dates, sync.queue_upgrades = orig, orig_q
        self.assertEqual(r["added"], 2)
        self.assertEqual(seen, [["FROMSTOCK"]])                  # a device first seen in Intune has no known deploy date


if __name__ == "__main__":
    unittest.main()
