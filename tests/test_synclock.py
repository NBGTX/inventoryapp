import datetime as dt
import unittest

import _env                     # noqa: F401
from _env import FakeSite, make_client

import app
import graph
import synclock


class FakeHub:
    """In-memory stand-in for hub.Hub's lock/status documents."""

    def __init__(self):
        self.lock, self.status = None, None
        self.puts = 0
        self.conflict = False

    def get_sync_lock(self):
        return dict(self.lock) if self.lock else None

    def put_sync_lock(self, d):
        if self.conflict:
            class HubConflict(Exception):
                pass
            raise HubConflict("changed")
        self.puts += 1
        self.lock = dict(d)

    def clear_sync_lock(self):
        self.lock = None

    def get_sync_status(self):
        return dict(self.status) if self.status else None

    def put_sync_status(self, d):
        self.status = dict(d)


def ago(minutes=0, hours=0):
    return synclock._iso(synclock._now() - dt.timedelta(minutes=minutes, hours=hours))


class Lock(unittest.TestCase):
    def test_acquire_release_and_blocked_while_held(self):
        h = FakeHub()
        tok, holder = synclock.acquire(h, "tech1")
        self.assertTrue(tok)
        self.assertIsNone(holder)
        tok2, holder2 = synclock.acquire(h, "tech2")
        self.assertIsNone(tok2)
        self.assertEqual(holder2["by"], "tech1")
        synclock.release(h, "wrong-token")
        self.assertIsNotNone(h.lock)                                  # only the owner can release
        synclock.release(h, tok)
        self.assertIsNone(h.lock)
        self.assertTrue(synclock.acquire(h, "tech2")[0])

    def test_a_stale_lock_is_taken_over(self):
        h = FakeHub()
        h.lock = {"token": "old", "by": "crashed", "started": ago(minutes=synclock.LOCK_TTL_MIN + 5)}
        tok, holder = synclock.acquire(h, "me")
        self.assertTrue(tok)
        self.assertEqual(h.lock["by"], "me")

    def test_a_live_lock_is_respected_and_garbage_dates_do_not_block(self):
        h = FakeHub()
        h.lock = {"token": "x", "by": "other", "started": ago(minutes=2)}
        self.assertIsNone(synclock.acquire(h, "me")[0])
        h.lock = {"token": "x", "by": "other", "started": "not a date"}
        self.assertTrue(synclock.acquire(h, "me")[0])

    def test_losing_a_write_race_means_blocked(self):
        h = FakeHub()
        h.conflict = True
        tok, holder = synclock.acquire(h, "me")
        self.assertIsNone(tok)

    def test_hub_failure_does_not_block_the_sync(self):
        class Broken(FakeHub):
            def get_sync_lock(self):
                raise RuntimeError("sharepoint down")
        self.assertEqual(synclock.acquire(Broken(), "me"), ("unlocked", None))
        synclock.release(Broken(), "unlocked")                         # no error


class RunLocked(unittest.TestCase):
    def test_runs_records_status_and_releases(self):
        h = FakeHub()
        res, holder = synclock.run_locked(h, "me", "app", lambda: {"count": 5, "errors": []},
                                          lambda r: {"ok": True, "count": r["count"], "errors": []})
        self.assertEqual((res["count"], holder), (5, None))
        self.assertIsNone(h.lock)
        st = h.status
        self.assertEqual((st["count"], st["by"], st["source"], st["ok"]), (5, "me", "app", True))
        self.assertTrue(st["started"].endswith("Z") and st["ended"].endswith("Z"))

    def test_a_crash_inside_still_releases_and_marks_the_run_failed(self):
        h = FakeHub()
        with self.assertRaises(ValueError):
            synclock.run_locked(h, "me", "app", lambda: (_ for _ in ()).throw(ValueError("x")), lambda r: {"ok": True})
        self.assertIsNone(h.lock)
        self.assertFalse(h.status["ok"])

    def test_blocked_run_does_not_call_fn_or_touch_status(self):
        h = FakeHub()
        h.lock = {"token": "x", "by": "other", "machine": "PC9", "started": ago(minutes=1)}
        called = []
        res, holder = synclock.run_locked(h, "me", "app", lambda: called.append(1), lambda r: {})
        self.assertEqual((res, called, h.status), (None, [], None))
        self.assertEqual(holder["machine"], "PC9")

    def test_merge_adds_to_the_last_run_without_replacing_its_start(self):
        h = FakeHub()
        synclock.run_locked(h, "me", "app", lambda: {"count": 5}, lambda r: {"ok": True, "count": 5})
        started = h.status["started"]
        synclock.run_locked(h, "me", "app", lambda: {"enriched": 4}, lambda r: {"enriched": r["enriched"]}, merge=True)
        self.assertEqual((h.status["count"], h.status["enriched"], h.status["started"]), (5, 4, started))


class StatusView(unittest.TestCase):
    def test_never_fresh_and_stale(self):
        h = FakeHub()
        s = synclock.status(h)
        self.assertTrue(s["never"] and s["stale"] and s["age_hours"] is None)
        h.status = {"ended": ago(hours=2)}
        s = synclock.status(h)
        self.assertFalse(s["stale"] or s["never"])
        self.assertAlmostEqual(s["age_hours"], 2, delta=0.1)
        h.status = {"ended": ago(hours=synclock.STALE_HOURS + 1)}
        self.assertTrue(synclock.status(h)["stale"])


class ApiAndSyncAll(unittest.TestCase):
    def setUp(self):
        import sync
        self.sync = sync
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        FakeSite(self.gc)
        self.gc.account_upn = "boss@nucor.com"
        self.hub = FakeHub()
        self.api = app.Api()
        self.api._gc, self.api._hub = self.gc, self.hub
        self.runs = []
        self._orig = (sync.run_sync, sync.enrich_in_use)
        outer = self
        sync.run_sync = lambda c, commit=False: (outer.runs.append(c.division["id"]) or
                                                 {"moved": [{}], "updated": 2, "deduped": 0, "count": 9, "errors": []})
        sync.enrich_in_use = lambda c, commit=True, cap=None: {"enriched": 1, "sites": 1, "errors": []}

    def tearDown(self):
        self.sync.run_sync, self.sync.enrich_in_use = self._orig

    def test_app_launch_sync_records_status_and_reports_when_locked(self):
        r = self.api.run_sync()
        self.assertTrue(r["ok"] and "locked" not in r)
        self.assertEqual((self.hub.status["count"], self.hub.status["added"], self.hub.status["updated"]), (9, 1, 2))
        self.assertIsNone(self.hub.lock)
        self.hub.lock = {"token": "t", "by": "Other Tech", "machine": "PC2", "started": ago(minutes=3)}
        n = len(self.runs)
        r = self.api.run_sync()
        self.assertEqual(r["locked"]["by"], "Other Tech")
        self.assertEqual((r["moved"], r["errors"], len(self.runs)), ([], [], n))        # UI-safe shape, nothing ran
        self.assertEqual(self.api.enrich_inventory()["locked"]["machine"], "PC2")

    def test_enrich_merges_into_the_status(self):
        self.api.run_sync()
        self.api.enrich_inventory()
        self.assertEqual((self.hub.status["count"], self.hub.status["enriched"]), (9, 2))

    def test_api_status_endpoint(self):
        self.assertTrue(self.api.get_sync_status()["never"])
        self.api.run_sync()
        st = self.api.get_sync_status()
        self.assertFalse(st["stale"])
        self.assertEqual(st["count"], 9)

    def test_sync_all_takes_each_divisions_lock_and_skips_a_busy_one(self):
        self.gc.registry = [
            {"id": "nbgw", "name": "W", "company_name": "c", "intune_category": "W", "sites": [], "lists": {}, "legacy_data": True, "access": []},
            {"id": "nbgtx", "name": "TX", "company_name": "c", "intune_category": "T", "sites": [], "lists": {}, "legacy_data": False, "access": []},
        ]
        hubs = {"nbgw": FakeHub(), "nbgtx": FakeHub()}
        hubs["nbgtx"].lock = {"token": "t", "by": "Someone", "machine": "PC7", "started": ago(minutes=1)}
        graph.GraphClient.add_log = lambda *a, **k: None
        r = self.sync.sync_all(self.gc, commit=True, hub_factory=lambda c: hubs[c.division["id"]])
        by = {d["id"]: d for d in r["divisions"]}
        self.assertTrue(by["nbgw"]["ok"])
        self.assertEqual(hubs["nbgw"].status["count"], 9)
        self.assertTrue(by["nbgtx"].get("skipped"))
        self.assertIn("another sync is already running", by["nbgtx"]["errors"][0])
        self.assertEqual(self.runs, ["nbgw"])                                            # the busy division was not touched
        self.assertIsNone(hubs["nbgtx"].status)
        self.assertFalse(r["ok"])

    def test_overview_is_super_admin_only(self):
        self.gc.account_upn = "nobody@nucor.com"
        self.assertEqual(self.api.get_sync_overview(), {"ok": True, "super_admin": False, "divisions": []})


if __name__ == "__main__":
    unittest.main()


class LongJobsBlockDivisionSwitch(unittest.TestCase):
    def test_software_refresh_counts_as_a_long_op_and_switch_is_refused_meanwhile(self):
        gc = make_client()
        FakeSite(gc)
        api = app.Api()
        api._gc = gc
        api._hub = FakeHub()
        seen = {}

        def slow():
            seen["busy"] = api._busy
            seen["switch"] = api.switch_division("nbgw")          # a click on the switcher mid-refresh
            return {"apps": [], "devices": 0}
        gc.software_inventory = slow
        api._hub.save_software = lambda inv: None
        api.software_refresh()
        self.assertEqual(seen["busy"], 1)
        self.assertFalse(seen["switch"]["ok"])
        self.assertIn("still running", seen["switch"]["error"])
        self.assertEqual(api._busy, 0)
