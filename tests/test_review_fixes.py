"""Regression tests for the code-review findings (cross-division isolation, ACL fail-closed, hub integrity)."""
import types
import unittest

import _env
from _env import FakeSite, make_client

import app
import divisions
import graph
import hub
import hubstore
import load_central as lc
import test_hubstore_and_loader as th


class LegacyKeysDoNotLeak(unittest.TestCase):
    def test_second_division_does_not_inherit_nbgw_flat_config(self):
        gc = make_client(central=False, extra={"timesheet_sql_server": "BGBRISQL07", "ad_domain": "bg.nucorsteel.local"})
        gc.registry.append({"id": "nbgtx", "name": "TX", "company_name": "NBG - Terrell", "intune_category": "NBGTX",
                            "sites": [], "lists": {}, "legacy_data": False})
        self.assertEqual(gc.cfg["timesheet_sql_server"], "BGBRISQL07")           # NBGW still has them
        gc.set_division("nbgtx", persist=False)
        self.assertFalse(gc.cfg.get("timesheet_sql_server"))
        self.assertFalse(gc.cfg.get("ad_domain"))
        self.assertFalse(gc.cfg.get("site_path"))
        self.assertEqual(gc.cfg["intune_device_category"], "NBGTX")

    def test_company_name_missing_raises_not_nbgw(self):
        api = app.Api()
        gc = make_client(central=False)
        gc.registry.append({"id": "nbgtx", "name": "TX", "company_name": "", "sites": [], "lists": {}, "legacy_data": False})
        gc.set_division("nbgtx", persist=False)
        api._gc = gc
        with self.assertRaises(RuntimeError):
            api._division_company()


class OwnItemChecks(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        self.site = FakeSite(self.gc)
        self.a = self.site.add("new_stock", Title="A", Division="nbgw")
        self.b = self.site.add("new_stock", Title="B", Division="nbgtx")
        rows = {r["id"]: r for r in self.site.rows["new_stock"]}
        self.gc._get = lambda url: rows[url.split("/items/")[1].split("?")[0]]

    def test_cannot_touch_another_divisions_item(self):
        with self.assertRaises(graph.GraphError):
            self.gc.delete_item("new_stock", self.b["id"])
        with self.assertRaises(graph.GraphError):
            self.gc.update_item("new_stock", self.b["id"], {"model": "X"})
        self.assertFalse([s for s in self.site.sent if s[0] in ("DELETE", "PATCH")])

    def test_own_item_ok_and_checked_flag_skips_lookup(self):
        self.gc.delete_item("new_stock", self.a["id"])
        self.gc.update_item("new_stock", self.a["id"], {"model": "X"})
        self.assertEqual([s[0] for s in self.site.sent if s[0] in ("DELETE", "PATCH")], ["DELETE", "PATCH"])
        self.gc._get = lambda url: self.fail("lookup despite _checked")
        self.gc.delete_item("new_stock", self.a["id"], _checked=True)


class RegistryFailsClosed(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        self.site = FakeSite(self.gc)
        self.gc.account_upn = "user@nucor.com"
        self.site.add("divisions", Title="nbgw", DisplayName="NBGW", Enabled="Yes", AccessJson='["*"]')   # NBGW open to everyone

    def test_bad_ids_and_site_codes_are_dropped(self):
        bad = '[{"code":"X\\" onmouseover=\\"1","name":"x"},{"code":"OK1","name":"ok","city_prefixes":["c"],"device_prefixes":["BGOK"]},{"code":"OTHER"}]'
        self.site.add("divisions", Title="nbgtx", DisplayName="TX", CompanyName="c", IntuneCategory="i", SitesJson=bad, Enabled="Yes")
        self.site.add("divisions", Title="Bad/../Id", DisplayName="evil", Enabled="Yes")
        self.gc.refresh_registry(force=True)
        ids = sorted(d["id"] for d in self.gc.registry)
        self.assertEqual(ids, ["nbgtx", "nbgw"])
        tx = next(d for d in self.gc.registry if d["id"] == "nbgtx")
        self.assertEqual([s["code"] for s in tx["sites"]], ["OK1"])

    def test_malformed_acl_denies_everyone_but_admins(self):
        self.site.add("divisions", Title="nbgtx", DisplayName="TX", CompanyName="c", IntuneCategory="i",
                      AccessJson="not json", Enabled="Yes")
        self.gc.refresh_registry(force=True)
        self.assertEqual(sorted(d["id"] for d in self.gc.visible_registry()), ["nbgw"])
        self.gc._base_cfg["super_admins"] = ["user@nucor.com"]
        self.assertEqual(sorted(d["id"] for d in self.gc.visible_registry()), ["nbgtx", "nbgw"])

    def test_no_visible_division_is_empty_not_first_one(self):
        self.site.add("divisions", Title="nbgw", DisplayName="NBGW", AccessJson='["boss@nucor.com"]', Enabled="Yes")
        self.gc.refresh_registry(force=True)
        self.assertEqual(self.gc.visible_registry(), [])
        api = app.Api()
        api._gc = self.gc
        r = api.get_divisions()
        self.assertFalse(r["ok"])
        self.assertIn("No division is available", r["error"])

    def test_active_division_hidden_repoints_and_resets_hub(self):
        self.gc.registry.append({"id": "nbgtx", "name": "TX", "company_name": "c", "sites": [], "lists": {}, "legacy_data": False})
        self.gc.set_division("nbgtx", persist=False)
        self.site.add("divisions", Title="nbgtx", DisplayName="TX", Enabled="No")
        api = app.Api()
        api._gc = self.gc
        api._hub = object()
        r = api.get_divisions()
        self.assertTrue(r["ok"])
        self.assertEqual(r["current"], "nbgw")
        self.assertIsNone(api._hub)

    def test_central_log_list_is_never_auto_created(self):
        self.gc._get_all = lambda url: []
        self.gc._ensure_log_list = graph.GraphClient._ensure_log_list.__get__(self.gc)
        self.gc._list_ids = {}
        with self.assertRaises(graph.GraphError) as cm:
            self.gc._ensure_log_list()
        self.assertIn("not found", str(cm.exception))


class HubIntegrity(unittest.TestCase):
    def setUp(self):
        th.MemStore.reset()

    def test_mixed_revisions_raise_on_read_and_are_repaired_by_a_write(self):
        st = th.MemStore()
        st.write("upgrade-list", "main", '{"items": [1]}')
        th.MemStore.ROWS.append({"id": "99", "kind": "upgrade-list", "item_id": "main#0001", "rev": 7, "payload": "garbage"})
        st._cache.clear()
        orig = hubstore.time.sleep
        hubstore.time.sleep = lambda s: None
        try:
            with self.assertRaises(hubstore.HubConflict):
                st.read("upgrade-list", "main")
            st._rev.clear()
            st.write("upgrade-list", "main", '{"items": [2]}')            # repairs
            st._cache.clear()
            self.assertEqual(st.read("upgrade-list", "main"), '{"items": [2]}')
        finally:
            hubstore.time.sleep = orig

    def test_patch_404_is_a_conflict_but_delete_404_is_fine(self):
        class R:
            def __init__(self, statuses):
                self.s = statuses

            def json(self):
                return {"responses": [{"id": str(i), "status": s} for i, s in enumerate(self.s)]}
        gc = types.SimpleNamespace(division={"id": "nbgw"}, _ensure_site=lambda: "S", _list_id=lambda k: "L")
        st = hubstore.SharePointHubStore(gc)
        gc._req = lambda m, u, **k: R([404])
        with self.assertRaises(hubstore.HubConflict):
            st._apply([("patch", "1", {"Payload": "x"})])
        st._apply([("delete", "1")])                                          # 404 on delete: already gone

    def test_hub_writes_stay_with_the_division_it_was_built_for(self):
        gc = types.SimpleNamespace(division={"id": "nbgw"})
        st = hubstore.SharePointHubStore(gc)
        gc.division = {"id": "nbgtx"}                                        # user switches mid-run
        self.assertEqual(st._div(), "nbgw")

    def test_blob_names_cannot_traverse(self):
        gc = types.SimpleNamespace(division={"id": "nbgw"}, _ensure_site=lambda: "S", _list_id=lambda k: "L")
        st = hubstore.SharePointHubStore(gc)
        for bad in ("../x.html", "a/b.html", "a\\b.html", ""):
            with self.assertRaises(ValueError):
                st._blob_url(bad)
        self.assertIn("nbgw/ok.html", st._blob_url("ok.html"))


class BusyGuardAndSnapshot(unittest.TestCase):
    def test_division_switch_refused_during_a_long_operation(self):
        import sync
        api = app.Api()
        gc = make_client(central=False)
        api._gc = gc
        seen = {}

        def fake_run_sync(c, commit=False):
            seen["switch"] = api.switch_division("nbgw")
            return {}
        orig = sync.run_sync
        sync.run_sync = fake_run_sync
        try:
            api.run_sync()
        finally:
            sync.run_sync = orig
        self.assertFalse(seen["switch"]["ok"])
        self.assertIn("still running", seen["switch"]["error"])
        self.assertEqual(api._busy, 0)
        self.assertTrue(api.switch_division("nbgw")["ok"])                   # allowed again afterwards

    def test_snapshot_clone_has_independent_flags(self):
        gc = make_client()
        snap = gc.clone_for_snapshot()
        self.assertIsNot(snap, gc)
        snap._use_legacy = True
        snap._force_live = True
        snap._apply_division()
        self.assertTrue(gc._central)
        self.assertFalse(gc._force_live)
        self.assertFalse(snap._central)


class LoaderSafety(unittest.TestCase):
    def args(self, **kw):
        base = dict(division="nbgw", confirm_division="", max_snapshot_age_days=7.0)
        base.update(kw)
        return types.SimpleNamespace(**base)

    def fresh(self, **counts):
        import datetime
        return {"taken_at": datetime.datetime.now().isoformat(timespec="seconds"), "counts": counts or {"new_stock": 5, "in_use": 5}}

    def test_wipe_requires_typed_confirmation(self):
        self.assertIn("--confirm-division", lc.wipe_problem(self.args(), self.fresh(), {}))
        self.assertIsNone(lc.wipe_problem(self.args(confirm_division="nbgw"), self.fresh(), {}))

    def test_wipe_refuses_empty_or_old_snapshots(self):
        a = self.args(confirm_division="nbgw")
        self.assertIn("no New Stock", lc.wipe_problem(a, self.fresh(new_stock=0, in_use=0), {}))
        self.assertIn("days old", lc.wipe_problem(a, {"taken_at": "2020-01-01T00:00:00", "counts": {"new_stock": 5}}, {}))
        self.assertIn("timestamp", lc.wipe_problem(a, {"taken_at": "", "counts": {"new_stock": 5}}, {}))

    def test_wipe_never_includes_log_or_model_specs(self):
        self.assertEqual(lc.WIPE_KEYS, ("new_stock", "in_use"))


if __name__ == "__main__":
    unittest.main()


class RevParsing(unittest.TestCase):
    def test_number_column_values_from_sharepoint(self):
        for raw, want in ((1, 1), (1.0, 1), ("1", 1), ("1.0", 1), ("", 0), (None, 0), ("x", 0), (12.0, 12)):
            self.assertEqual(hubstore._int(raw), want, raw)


class CleanUpn(unittest.TestCase):
    def test_strips_glued_hex_prefix_only(self):
        c = graph.clean_upn
        self.assertEqual(c("abb60fd585a34220a66f7169bdee9126Don.Corbell@nucor.com"), "Don.Corbell@nucor.com")
        self.assertEqual(c("911f3fdb9cf8463d8b7238ba0cc4c910navjot.singh@nucor.com"), "navjot.singh@nucor.com")
        self.assertEqual(c("jane.doe@nucor.com"), "jane.doe@nucor.com")
        self.assertEqual(c("  Jane.Doe@nucor.com "), "Jane.Doe@nucor.com")
        self.assertEqual(c(None), "")
        self.assertEqual(c(""), "")
        self.assertEqual(c("abb60fd585a34220a66f7169bdee9126@nucor.com"), "abb60fd585a34220a66f7169bdee9126@nucor.com")  # nothing after the hex: leave it
        self.assertEqual(c("1234567890abcdef@nucor.com"), "1234567890abcdef@nucor.com")     # short hex name: leave it


class EmptyAccessMeansSuperAdminsOnly(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        self.site = FakeSite(self.gc)
        self.gc.account_upn = "user@nucor.com"

    def vis(self):
        return sorted(d["id"] for d in self.gc.visible_registry())

    def test_empty_list_hides_the_division_from_normal_users(self):
        self.site.add("divisions", Title="nbgw", DisplayName="NBGW", Enabled="Yes", AccessJson="[]")
        self.gc.refresh_registry(force=True)
        self.assertEqual(self.vis(), [])

    def test_star_means_everyone(self):
        self.site.add("divisions", Title="nbgw", DisplayName="NBGW", Enabled="Yes", AccessJson='["*"]')
        self.gc.refresh_registry(force=True)
        self.assertEqual(self.vis(), ["nbgw"])

    def test_super_admins_always_see_everything_even_with_empty_lists(self):
        self.site.add("divisions", Title="nbgw", DisplayName="NBGW", Enabled="Yes", AccessJson="[]")
        self.gc.refresh_registry(force=True)
        self.gc._base_cfg["super_admins"] = ["user@nucor.com"]
        self.assertEqual(self.vis(), ["nbgw"])

    def test_a_listed_person_sees_it_others_do_not(self):
        self.site.add("divisions", Title="nbgw", DisplayName="NBGW", Enabled="Yes", AccessJson='["user@nucor.com"]')
        self.gc.refresh_registry(force=True)
        self.assertEqual(self.vis(), ["nbgw"])
        self.gc.account_upn = "other@nucor.com"
        self.assertEqual(self.vis(), [])

    def test_central_read_failure_fails_closed_for_normal_users(self):
        self.gc._items_raw = lambda k: (_ for _ in ()).throw(RuntimeError("down"))
        self.gc.refresh_registry(force=True)                  # falls back to config.json's built-in NBGW (no access list)
        self.assertEqual(self.vis(), [])

    def test_single_division_installs_without_a_central_site_have_no_access_control(self):
        gc = make_client(central=False)
        gc.account_upn = "anyone@nucor.com"
        self.assertEqual([d["id"] for d in gc.visible_registry()], ["nbgw"])
