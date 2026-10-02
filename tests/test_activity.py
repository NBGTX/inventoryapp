import tempfile
import unittest
from datetime import datetime, timedelta, timezone

import _env                     # noqa: F401
from _env import FakeSite, make_client

import activity
import app
import hub as hubmod
from hub import Hub

NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)


def iso(**kw):
    return (NOW - timedelta(**kw)).isoformat()


class Build(unittest.TestCase):
    def test_areas_from_what_changed(self):
        a = activity.area_of
        self.assertEqual([a("Upgrade list"), a("NBT Sites"), a("Software rules"), a("MFA list"), a("Timesheet unlock"), a("Issue filed"),
                          a("Signed in"), a("Role access changed"), a("Master setting changed"), a("Bulk Remove devices"), a("???")],
                         ["Upgrades", "NBT Sites", "Software", "Teammates", "BG Tools", "Issues", "Access", "Access", "Settings", "Devices", "Other"])

    def test_merge_sorts_newest_first_and_labels_scope(self):
        inv = [{"when": iso(hours=3), "action": "Deployed", "serial": "S1", "model": "M", "actor": "Ann", "details": "x"},
               {"when": iso(hours=1), "action": "Sync", "serial": "", "actor": "Bob", "details": "2 added"}]
        div = [{"when": iso(hours=2), "user": "Cy", "machine": "PC1", "target": "Upgrade list", "detail": "Bulk: 4 set to P5"}]
        plat = [{"when": iso(minutes=5), "user": "Di", "target": "Signed in", "detail": "di@x.com"}]
        r = activity.build(inv, div, plat, now=NOW)
        self.assertEqual([(e["who"], e["scope"], e["area"]) for e in r["entries"]],
                         [("Di", "Platform", "Access"), ("Bob", "Devices", "Sync"), ("Cy", "Division", "Upgrades"), ("Ann", "Devices", "Devices")])
        self.assertEqual((r["total"], r["truncated"]), (4, False))

    def test_period_limit_and_bad_dates(self):
        inv = [{"when": iso(days=2), "action": "Added", "actor": "A"}, {"when": iso(days=40), "action": "Added", "actor": "B"},
               {"when": "not a date", "action": "Added", "actor": "C"}, {"when": "2026-10-02T10:00:00", "action": "Added", "actor": "D"}]
        r = activity.build(inv, [], [], days=7, now=NOW)
        self.assertEqual(sorted(e["who"] for e in r["entries"]), ["A", "D"])             # old and unreadable rows fall outside a period
        self.assertEqual(activity.build(inv, [], [], days=0, now=NOW)["total"], 4)       # "all" keeps them (unreadable ones sort last)
        self.assertEqual(activity.build(inv, [], [], limit=2, now=NOW)["truncated"], True)


class Audit(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        FakeSite(self.gc)
        self.gc.sign_in = lambda interactive=False: ""
        self.gc.account_upn, self.gc.account_name = "boss@nucor.com", "Boss"
        self._orig = hubmod.platform_hub_for
        self.pdir = tempfile.mkdtemp()
        hubmod.platform_hub_for = lambda gc: Hub(logs_folder=self.pdir, division={"id": "_platform", "name": "P", "legacy_data": False, "sites": []})
        self.api = app.Api()
        self.api._gc = self.gc
        self.api._hub = Hub(logs_folder=tempfile.mkdtemp(), division={"id": "nbgw", "name": "W", "legacy_data": True, "sites": []})
        self.api._audit = lambda *a, **k: app.Api._audit_real(self.api, *a, **k)          # the real recorder, for these tests

    def tearDown(self):
        hubmod.platform_hub_for = self._orig

    def test_wrapper_records_successful_actions_only_and_never_a_secret_value(self):
        class Fake:
            calls = []

            def _audit(self, target, detail, scope):
                self.calls.append((target, detail, scope))

            def set_master_setting(self, key, value, secret=False, description=""):
                return {"ok": value != "bad"}
        t, s, d = app._AUDIT["set_master_setting"]
        Fake.set_master_setting = app._audited(Fake.set_master_setting, t, s, d)
        f = Fake()
        f.set_master_setting("lenovo_client_id", "TOP-SECRET-VALUE")
        f.set_master_setting("x", "bad")
        self.assertEqual(f.calls, [("Master setting changed", "lenovo_client_id (value not logged)", "platform")])
        self.assertNotIn("TOP-SECRET", str(f.calls))

    def test_every_audited_method_exists_on_the_api(self):
        for name in app._AUDIT:
            self.assertTrue(callable(getattr(app.Api, name, None)), name)

    def test_audit_writes_the_signed_in_person_to_the_right_feed(self):
        self.api._audit("Role access changed", "x", "platform")
        self.api._audit("Checklists changed", "y", "division")
        plat = Hub(logs_folder=self.pdir, division={"id": "_platform", "name": "P", "legacy_data": False, "sites": []}).get_changes()
        self.assertEqual([(c["target"], c["user"]) for c in plat], [("Role access changed", "Boss")])
        self.assertEqual([c["target"] for c in self.api._hub.get_changes()], ["Checklists changed"])

    def test_activity_is_for_admins_and_merges_all_feeds(self):
        self.api._audit("Signed in", "boss", "platform")
        self.api._audit("Upgrade list", "Bulk: 2 removed", "division")
        self.gc.get_log = lambda top=300: [{"when": iso(hours=1), "action": "Deployed", "serial": "S1", "model": "M", "actor": "Ann", "details": ""}]
        r = self.api.activity_get(0)
        self.assertTrue(r["ok"], r)
        self.assertEqual({e["scope"] for e in r["entries"]}, {"Devices", "Division", "Platform"})
        self.gc.account_upn = "tech@nucor.com"
        r = self.api.activity_get(0)
        self.assertFalse(r["ok"])
        self.assertIn("admins", r["error"])


if __name__ == "__main__":
    unittest.main()
