import tempfile
import unittest
from urllib.parse import unquote

import _env
from _env import FakeSite, make_client

import app
import settings_catalog as sc
from hub import Hub


class Catalog(unittest.TestCase):
    def test_every_catalog_entry_is_complete(self):
        keys = set()
        for c in sc.CATALOG:
            self.assertNotIn(c["key"], keys)
            keys.add(c["key"])
            for f in ("key", "group", "label", "kind", "secret", "help", "status"):
                self.assertIn(f, c)
            if c["kind"] == "choice":
                self.assertTrue(c["options"])
            if c["kind"] == "number":
                self.assertTrue(c["min"] <= c["default"] <= c["max"])
        for k in ("lenovo_client_id", "dell_client_id", "dell_client_secret", "hp_client_id", "hp_client_secret"):
            self.assertTrue(sc.entry(k)["secret"])

    def test_check_value(self):
        self.assertEqual(sc.check_value("default_timezone", "America/Chicago"), "America/Chicago")
        self.assertEqual(sc.check_value("default_timezone", ""), "")
        with self.assertRaises(ValueError):
            sc.check_value("default_timezone", "Mars/Base")
        self.assertEqual(sc.check_value("intune_enrich_per_sync", " 40 "), "40")
        self.assertEqual(sc.check_value("intune_enrich_per_sync", ""), "")
        for bad in ("abc", "-1", "9999", "1.5"):
            with self.assertRaises(ValueError):
                sc.check_value("intune_enrich_per_sync", bad)
        self.assertEqual(sc.check_value("not_in_catalog", " raw "), " raw ")

    def test_number_falls_back_to_default(self):
        gc = make_client()
        FakeSite(gc)
        self.assertEqual(sc.number(gc, "intune_enrich_per_sync"), 75)
        gc._base_cfg["intune_enrich_per_sync"] = 20            # config.json still works as a fallback
        self.assertEqual(sc.number(gc, "intune_enrich_per_sync"), 20)
        gc._base_cfg["intune_enrich_per_sync"] = 99999         # out of range: ignored
        self.assertEqual(sc.number(gc, "intune_enrich_per_sync"), 75)


class MasterSettingsApi(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        self.site = FakeSite(self.gc)
        self.site.add("master_settings", Title="lenovo_client_id", Value="SECRET", Secret="Yes")
        self.site.add("master_settings", Title="legacy_thing", Value="x", Secret="No")
        self.gc.account_upn = "boss@nucor.com"
        self.api = app.Api()
        self.api._gc = self.gc

    def test_catalog_masks_secrets_and_lists_unknown_rows_separately(self):
        r = self.api.get_master_settings()
        by = {c["key"]: c for c in r["catalog"]}
        self.assertTrue(by["lenovo_client_id"]["is_set"])
        self.assertEqual(by["lenovo_client_id"]["value"], "")
        self.assertFalse(by["dell_client_id"]["is_set"])
        self.assertEqual([o["key"] for o in r["other"]], ["legacy_thing"])
        self.assertNotIn("SECRET", str(r))

    def test_catalog_values_are_validated_and_secrecy_is_fixed(self):
        self.assertFalse(self.api.set_master_setting("default_timezone", "Mars/Base")["ok"])
        self.assertFalse(self.api.set_master_setting("stale_checkin_days", "zero")["ok"])
        self.assertTrue(self.api.set_master_setting("dell_client_id", "abc", False, "")["ok"])     # caller says not secret: ignored
        post = [s for s in self.site.sent if s[0] == "POST"][-1][2]["fields"]
        self.assertEqual(post[_env.DEFAULT_COLS["secret"]], "Yes")


class DivisionPrefs(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        FakeSite(self.gc)
        self.tmp = tempfile.mkdtemp()
        self.api = app.Api()
        self.api._gc = self.gc
        self.api._hub = Hub(logs_folder=self.tmp, division=self.gc.division)

    def test_default_then_set_then_clear(self):
        r = self.api.get_division_prefs()
        self.assertEqual((r["timezone"], r["effective"]), ("", ""))
        self.assertTrue(any(z["id"] == "America/Chicago" for z in r["zones"]))
        self.assertTrue(self.api.save_division_prefs("America/Chicago")["ok"])
        r = self.api.get_division_prefs()
        self.assertEqual((r["timezone"], r["effective"]), ("America/Chicago", "America/Chicago"))
        self.assertTrue(self.api.save_division_prefs("")["ok"])
        self.assertEqual(self.api.get_division_prefs()["timezone"], "")

    def test_rejects_unknown_zone_and_keeps_other_prefs(self):
        self.api._hubc().save_prefs({"timezone": "America/Denver", "other": 1})
        self.assertFalse(self.api.save_division_prefs("Nowhere/Land")["ok"])
        self.assertEqual(self.api._hubc().get_prefs()["timezone"], "America/Denver")
        self.api.save_division_prefs("America/Phoenix")
        self.assertEqual(self.api._hubc().get_prefs()["other"], 1)

    def test_master_default_is_used_when_the_division_has_none(self):
        self.gc._base_cfg["default_timezone"] = "America/Los_Angeles"
        r = self.api.get_division_prefs()
        self.assertEqual((r["timezone"], r["default"], r["effective"]), ("", "America/Los_Angeles", "America/Los_Angeles"))
        self.api.save_division_prefs("America/New_York")
        self.assertEqual(self.api.get_division_prefs()["effective"], "America/New_York")

    def test_hand_edited_bad_zone_is_ignored(self):
        self.api._hubc().save_prefs({"timezone": "garbage"})
        self.assertEqual(self.api.get_division_prefs()["timezone"], "")


class Pickers(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        FakeSite(self.gc)
        self.gc.account_upn = "boss@nucor.com"
        self.api = app.Api()
        self.api._gc = self.gc

    def test_company_lookup_returns_distinct_names_most_common_first(self):
        urls = []

        class R:
            def json(self_):
                return {"value": [{"companyName": "NBG - Terrell"}, {"companyName": "NBG - Terrell"},
                                  {"companyName": "NBG - Tulsa"}, {"companyName": ""}]}

        def req(m, url, **k):
            urls.append(url)
            return R()
        self.gc._req = req
        out = self.api.user_lookup("NBG o'", "company")["results"]
        self.assertIn("startswith(companyName,'NBG o''')", unquote(urls[0]))
        self.assertEqual([o["name"] for o in out], ["NBG - Terrell", "NBG - Tulsa"])

    def test_intune_categories_sorted_unique_and_admin_only(self):
        self.gc._get_all = lambda url: [{"displayName": "NBGW"}, {"displayName": "nbgtx"}, {"displayName": "NBGW"}, {"displayName": ""}]
        self.assertEqual(self.api.intune_categories()["categories"], ["nbgtx", "NBGW"])
        self.gc.account_upn = "nobody@nucor.com"
        self.gc._get_all = lambda url: self.fail("graph called")
        self.assertEqual(self.api.intune_categories(), {"ok": True, "categories": []})

    def test_sql_discover_validates_names_and_is_admin_only(self):
        self.assertFalse(self.api.sql_discover("srv; DROP")["ok"])
        self.assertFalse(self.api.sql_discover("srv", "db'x")["ok"])
        calls = []
        import sqltools
        orig = sqltools.run
        sqltools.run = lambda server, db, sql, *a, **k: (calls.append((server, db)) or {"rows": [{"n": "A"}, {"n": "B"}]})
        try:
            self.assertEqual(self.api.sql_discover("BGBRISQL07")["items"], ["A", "B"])
            self.assertEqual(calls[-1], ("BGBRISQL07", "master"))
            self.assertEqual(self.api.sql_discover("BGBRISQL07\\INST", "NBSTimesheet")["items"], ["A", "B"])
            self.assertEqual(calls[-1], ("BGBRISQL07\\INST", "NBSTimesheet"))
            self.gc.account_upn = "nobody@nucor.com"
            self.gc.division["sql_server"] = "OWNSRV"
            n = len(calls)
            self.assertEqual(self.api.sql_discover("OTHERSRV"), {"ok": True, "items": []})       # not their server
            self.assertEqual(len(calls), n)
            self.assertEqual(self.api.sql_discover("ownsrv")["items"], ["A", "B"])                  # their own: allowed
        finally:
            sqltools.run = orig


class TenantSettings(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        cols = dict(_env.DEFAULT_COLS)
        cols.update({"timesheet db": "field_20", "timesheet table": "field_21", "employee db": "field_22", "employee table": "field_23"})
        self.site = FakeSite(self.gc, colmaps={"divisions": cols})
        self.site.add("divisions", Title="nbgw", DisplayName="NBGW", Enabled="Yes", AccessJson='["*"]')
        self.gc.account_upn = "tech@nucor.com"            # NOT a super admin
        self.gc.refresh_registry(force=True)
        self.api = app.Api()
        self.api._gc = self.gc

    def patches(self):
        return [s for s in self.site.sent if s[0] == "PATCH"]

    def test_tenant_can_change_only_its_own_allowed_fields(self):
        r = self.api.save_own_division({"sql_server": "SRV1", "timesheet_db": "TS", "timesheet_table": "dbo.Locks",
                                        "employee_db": "EMP", "employee_table": "dbo.People", "ad_domain": "x.local",
                                        "name": "HACKED", "company_name": "evil", "intune_category": "EVIL", "enabled": False,
                                        "sites": [{"code": "ltr", "name": "Lathrop", "city_prefixes": ["lathrop"], "device_prefixes": ["BGLTR"]}]})
        self.assertTrue(r["ok"], r)
        sent = self.patches()[-1][2]
        self.assertEqual(sent["field_20"], "TS")
        self.assertEqual(sent["field_23"], "dbo.People")
        self.assertIn('"LTR"', sent[_env.DEFAULT_COLS["sites json"]])
        for forbidden in ("HACKED", "evil", "EVIL", "AccessJson", "Enabled", "Title"):
            self.assertNotIn(forbidden, str(sent))

    def test_validation_and_access_and_local_mode(self):
        self.assertFalse(self.api.save_own_division({"timesheet_table": "dbo.Locks; DROP"})["ok"])
        self.assertFalse(self.api.save_own_division({"sites": [{"code": "x"}]})["ok"])
        self.assertEqual(self.patches(), [])
        self.gc.registry[0]["access"] = ["someone@else.com"]                  # no access to the active division
        self.assertIn("do not have access", self.api.save_own_division({"sql_server": "S"})["error"])
        self.gc.registry[0]["access"] = ["*"]
        self.gc.data_mode = "local"
        self.assertIn("Local data mode", self.api.save_own_division({"sql_server": "S"})["error"])

    def acl(self):
        import json
        return json.loads(self.patches()[-1][2][_env.DEFAULT_COLS["access json"]])

    def test_tenant_adds_people_and_groups_to_its_own_division(self):
        self.gc.registry[0]["access"] = ["tech@nucor.com"]
        self.gc._get_all = lambda url: [{"id": "g-1"}]
        r = self.api.save_own_division({"access": ["Tech@Nucor.com", "New.Person@nucor.com", "group:G-1|Terrell IT", "new.person@nucor.com"]})
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.acl(), ["tech@nucor.com", "new.person@nucor.com", "group:G-1|Terrell IT"])

    def test_tenant_cannot_grant_everyone_or_undo_it(self):
        self.gc.registry[0]["access"] = ["tech@nucor.com"]
        self.assertTrue(self.api.save_own_division({"access": ["tech@nucor.com", "*"]})["ok"])
        self.assertEqual(self.acl(), ["tech@nucor.com"])                       # "*" dropped
        self.gc.registry[0]["access"] = ["*"]
        self.assertTrue(self.api.save_own_division({"access": ["tech@nucor.com"]})["ok"])
        self.assertEqual(self.acl(), ["tech@nucor.com", "*"])                   # platform "everyone" kept

    def test_tenant_cannot_lock_itself_out(self):
        self.gc.registry[0]["access"] = ["tech@nucor.com"]
        n = len(self.patches())
        r = self.api.save_own_division({"access": ["someone@nucor.com"]})
        self.assertIn("remove your own access", r["error"])
        self.assertEqual(len(self.patches()), n)

    def test_super_admin_may_grant_everyone_from_here(self):
        self.gc._base_cfg["super_admins"] = ["tech@nucor.com"]
        self.assertTrue(self.api.save_own_division({"access": ["*"]})["ok"])
        self.assertEqual(self.acl(), ["*"])

    def test_get_own_division_shape(self):
        r = self.api.get_own_division()
        self.assertTrue(r["ok"])
        self.assertEqual(r["id"], "nbgw")
        self.assertIn("sites", r)
        self.assertFalse(r["super_admin"])


if __name__ == "__main__":
    unittest.main()
