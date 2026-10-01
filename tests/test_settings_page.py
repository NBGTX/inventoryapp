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
        self.gc._base_cfg["super_admins"] = ["pref@nucor.com"]       # prefs are admin-only
        self.gc.account_upn = "pref@nucor.com"

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
            self.gc.division["access"] = ["admin:nobody@nucor.com"]
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
        self.site.add("divisions", Title="nbgw", DisplayName="NBGW", Enabled="Yes", AccessJson='["admin:tech@nucor.com"]')
        self.gc.account_upn = "tech@nucor.com"            # a division admin, NOT a super admin
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

    def test_tenant_admin_adds_people_and_groups_keeping_roles(self):
        self.gc._get_all = lambda url: [{"id": "g-1"}]
        r = self.api.save_own_division({"access": ["Admin:Tech@Nucor.com", "New.Person@nucor.com", "group:G-1|Terrell IT",
                                                   "admin:group:G-2|Terrell Leads", "new.person@nucor.com"]})
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.acl(), ["admin:tech@nucor.com", "new.person@nucor.com", "group:G-1|Terrell IT", "admin:group:G-2|Terrell Leads"])

    def test_tenant_cannot_grant_everyone_or_undo_it(self):
        self.assertTrue(self.api.save_own_division({"access": ["admin:tech@nucor.com", "*"]})["ok"])
        self.assertEqual(self.acl(), ["admin:tech@nucor.com"])                  # "*" dropped
        self.gc.registry[0]["access"] = ["admin:tech@nucor.com", "*"]
        self.assertTrue(self.api.save_own_division({"access": ["admin:tech@nucor.com"]})["ok"])
        self.assertEqual(self.acl(), ["admin:tech@nucor.com", "*"])             # platform "everyone" kept

    def test_tenant_cannot_lock_itself_out_of_admin(self):
        n = len(self.patches())
        r = self.api.save_own_division({"access": ["tech@nucor.com", "someone@nucor.com"]})   # demotes self
        self.assertIn("own admin rights", r["error"])
        self.assertEqual(len(self.patches()), n)

    def test_group_admin_counts(self):
        self.gc.registry[0]["access"] = ["admin:group:G-9|Leads"]
        self.gc._get_all = lambda url: [{"id": "g-9"}]
        self.assertEqual(self.gc.division_role(), "admin")
        self.assertTrue(self.api.save_own_division({"sql_server": "S"})["ok"])

    def test_roles(self):
        g = self.gc
        g.registry[0]["access"] = ["admin:tech@nucor.com"]
        self.assertEqual(g.division_role(), "admin")
        g.registry[0]["access"] = ["tech@nucor.com"]
        self.assertEqual(g.division_role(), "user")
        g.registry[0]["access"] = ["*"]
        self.assertEqual(g.division_role(), "user")                              # everyone = user, never admin
        g.registry[0]["access"] = ["admin:*", "other@nucor.com"]
        self.assertEqual(g.division_role(), "")
        g.registry[0]["access"] = []
        self.assertEqual(g.division_role(), "")
        g._base_cfg["super_admins"] = ["tech@nucor.com"]
        self.assertEqual(g.division_role(), "super")
        self.assertEqual(make_client(central=False).division_role(), "admin")    # single-division install: no access control

    def test_plain_user_cannot_change_anything(self):
        self.gc.registry[0]["access"] = ["tech@nucor.com"]
        n = len(self.patches())
        for data in ({"sql_server": "S"}, {"access": ["tech@nucor.com", "x@nucor.com"]}, {"sites": []}):
            self.assertIn("role does not allow", self.api.save_own_division(data)["error"])
        self.assertEqual(len(self.patches()), n)
        self.assertFalse(self.api.save_division_prefs("America/Chicago")["ok"])
        self.assertFalse(self.api.perm_save_baselines({"departments": {}})["ok"])
        self.assertEqual(self.api.get_my_role(), {"ok": True, "role": "user", "sections": []})
        self.assertEqual(self.api.get_own_division()["role"], "user")

    def test_super_admin_may_grant_everyone_from_here(self):
        self.gc._base_cfg["super_admins"] = ["tech@nucor.com"]
        self.gc.registry[0]["access"] = ["*"]
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


class RoleAccessMatrix(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        cols = dict(_env.DEFAULT_COLS)
        cols.update({"timesheet db": "field_20", "timesheet table": "field_21", "employee db": "field_22", "employee table": "field_23"})
        self.site = FakeSite(self.gc, colmaps={"divisions": cols})
        self.site.add("divisions", Title="nbgw", DisplayName="NBGW", Enabled="Yes", AccessJson='["admin:adm@nucor.com","user@nucor.com"]')
        self.gc.refresh_registry(force=True)
        self.api = app.Api()
        self.api._gc = self.gc

    def as_(self, who):
        self.gc.account_upn = who
        self.gc._master_cache = None

    def test_defaults_user_sees_nothing_extra_admin_sees_all(self):
        self.as_("user@nucor.com")
        self.assertEqual(self.api.get_my_role()["sections"], [])
        self.as_("adm@nucor.com")
        self.assertEqual(len(self.api.get_my_role()["sections"]), len(sc.SECTIONS))
        self.as_("boss@nucor.com")
        self.assertEqual(len(self.api.get_my_role()["sections"]), len(sc.SECTIONS))

    def test_super_admin_saves_matrix_and_it_drives_sections_and_enforcement(self):
        self.as_("boss@nucor.com")
        self.assertTrue(self.api.save_role_access({"user": ["sites"], "admin": ["sites", "access"]})["ok"])
        row = [s for s in self.site.sent if s[0] in ("POST", "PATCH")][-1][2]
        self.assertIn('"sites"', str(row))
        self.site.add("master_settings", Title="role_access", Value='{"user": ["sites"], "admin": ["sites", "access"]}', Secret="No")
        self.as_("user@nucor.com")
        self.assertEqual(self.api.get_my_role()["sections"], ["sites"])
        self.assertTrue(self.api.save_own_division({"sites": [{"code": "LTR", "name": "L"}]})["ok"])          # allowed section
        self.assertIn("role does not allow", self.api.save_own_division({"sql_server": "S"})["error"])           # not allowed
        self.assertIn("role does not allow", self.api.save_own_division({"access": ["user@nucor.com"]})["error"])
        self.as_("adm@nucor.com")
        self.assertEqual(self.api.get_my_role()["sections"], ["access", "sites"])
        self.assertIn("role does not allow", self.api.save_own_division({"sql_server": "S"})["error"])           # admin has no 'sql' now

    def test_only_super_admins_read_or_change_the_matrix_and_input_is_validated(self):
        self.as_("adm@nucor.com")
        self.assertEqual(self.api.get_role_access(), {"ok": True, "super_admin": False})
        self.assertFalse(self.api.save_role_access({"user": [], "admin": []})["ok"])
        self.as_("boss@nucor.com")
        self.assertFalse(self.api.save_role_access({"user": ["../etc"], "admin": []})["ok"])
        self.assertFalse(self.api.save_role_access("nope")["ok"])
        r = self.api.get_role_access()
        self.assertEqual(r["matrix"], {"user": [], "admin": [s for s, _ in sc.SECTIONS]})

    def test_garbage_in_the_row_falls_back_to_defaults(self):
        self.assertEqual(sc.parse_role_access("not json"), sc.default_role_access())
        self.assertEqual(sc.parse_role_access('{"user": ["sites", "bogus"]}')["user"], ["sites"])

    def test_single_division_install_gives_admin_sections_to_everyone(self):
        gc = make_client(central=False)
        gc.account_upn = "anyone@nucor.com"
        self.assertEqual(gc.allowed_sections(), [s for s, _ in sc.SECTIONS])


class ApiInitRace(unittest.TestCase):
    def test_many_threads_get_one_graph_client(self):
        import threading
        import time
        made = []

        class Slow:
            def __init__(self):
                time.sleep(0.05)
                made.append(self)

        api = app.Api()
        api._GraphClient = Slow
        seen, barrier = [], threading.Barrier(8)

        def go():
            barrier.wait()
            seen.append(api._client())
        ts = [threading.Thread(target=go) for _ in range(8)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(len(made), 1)
        self.assertEqual(len({id(x) for x in seen}), 1)


class ProjectHubAddress(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        FakeSite(self.gc)
        self.tmp = tempfile.mkdtemp()
        self.api = app.Api()
        self.api._gc = self.gc
        self.api._hub = Hub(logs_folder=self.tmp, division=self.gc.division)
        self.gc._base_cfg["super_admins"] = ["adm@nucor.com"]
        self.gc.account_upn = "adm@nucor.com"

    def test_default_then_own_then_back_to_default(self):
        r = self.api.get_division_prefs()
        self.assertEqual((r["project_hub_url"], r["project_hub_effective"]), ("", sc.PROJECT_HUB_DEFAULT))
        self.assertTrue(self.api.save_division_prefs(None, "projecthub.terrell.example.com/start")["ok"])
        r = self.api.get_division_prefs()
        self.assertEqual(r["project_hub_effective"], "https://projecthub.terrell.example.com/start")
        self.assertTrue(self.api.save_division_prefs(None, "")["ok"])
        self.assertEqual(self.api.get_division_prefs()["project_hub_effective"], sc.PROJECT_HUB_DEFAULT)

    def test_master_default_applies_when_the_division_has_none(self):
        self.gc._base_cfg["project_hub_url"] = "https://hub.platform.example.com/"
        self.assertEqual(self.api.get_division_prefs()["project_hub_effective"], "https://hub.platform.example.com/")
        self.api.save_division_prefs(None, "https://own.example.com/")
        self.assertEqual(self.api.get_division_prefs()["project_hub_effective"], "https://own.example.com/")

    def test_saving_one_pref_keeps_the_other(self):
        self.api.save_division_prefs("America/Chicago", "https://own.example.com/")
        self.api.save_division_prefs(None, "https://other.example.com/")
        r = self.api.get_division_prefs()
        self.assertEqual((r["timezone"], r["project_hub_url"]), ("America/Chicago", "https://other.example.com/"))
        self.api.save_division_prefs("", None)
        self.assertEqual(self.api.get_division_prefs()["project_hub_url"], "https://other.example.com/")

    def test_bad_addresses_are_rejected(self):
        for bad in ("http://insecure.example.com", "javascript:alert(1)", "https://user:pw@example.com/", "https://has space.example.com",
                    "https://localhost/", "ftp://example.com/", "https://" + "a" * 400 + ".com"):
            self.assertFalse(self.api.save_division_prefs(None, bad)["ok"], bad)
        self.assertEqual(self.api.get_division_prefs()["project_hub_url"], "")

    def test_a_hand_edited_bad_value_is_ignored(self):
        self.api._hubc().save_prefs({"project_hub_url": "javascript:alert(1)"})
        self.assertEqual(self.api.get_division_prefs()["project_hub_effective"], sc.PROJECT_HUB_DEFAULT)

    def test_plain_users_cannot_change_it(self):
        self.gc._base_cfg["super_admins"] = []
        self.gc.account_upn = "plain@nucor.com"
        self.assertFalse(self.api.save_division_prefs(None, "https://x.example.com/")["ok"])

    def test_catalog_validates_the_platform_default_too(self):
        self.assertEqual(sc.check_value("project_hub_url", " https://hub.example.com/a "), "https://hub.example.com/a")
        self.assertEqual(sc.check_value("project_hub_url", ""), "")
        with self.assertRaises(ValueError):
            sc.check_value("project_hub_url", "file:///c:/x")

    def test_open_external_only_opens_web_addresses(self):
        import webbrowser
        opened = []
        orig, webbrowser.open = webbrowser.open, lambda u: opened.append(u)
        try:
            self.assertFalse(self.api.open_external("file:///C:/Windows/System32/cmd.exe")["ok"])
            self.assertFalse(self.api.open_external("javascript:alert(1)")["ok"])
            self.assertTrue(self.api.open_external("https://ok.example.com/")["ok"])
        finally:
            webbrowser.open = orig
        self.assertEqual(opened, ["https://ok.example.com/"])


class TemplateChecklists(unittest.TestCase):
    CFG = {"user": {"sections": []}, "computerBase": {"sections": []}, "departments": {"Eng": {"sections": []}}}

    def setUp(self):
        import hub as hubmod
        self.hubmod = hubmod
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        FakeSite(self.gc)
        self.gc.account_upn = "boss@nucor.com"
        self.div_hub = Hub(logs_folder=tempfile.mkdtemp(), division=self.gc.division)
        self.tpl_dir = tempfile.mkdtemp()
        self._orig = hubmod.template_hub_for
        hubmod.template_hub_for = lambda gc: Hub(logs_folder=self.tpl_dir, division={"id": "_template", "name": "T", "legacy_data": False, "sites": []})
        self.api = app.Api()
        self.api._gc, self.api._hub = self.gc, self.div_hub

    def tearDown(self):
        self.hubmod.template_hub_for = self._orig

    def test_new_division_gets_the_template_as_seed_until_it_has_its_own(self):
        self.assertEqual(self.api.hub_get_config(), {"ok": True, "config": None, "seed": None})       # no template yet: JS uses built-ins
        self.assertTrue(self.api.hub_save_template_config(self.CFG, {"action": "save"})["ok"])
        r = self.api.hub_get_config()
        self.assertIsNone(r["config"])
        self.assertEqual(r["seed"]["departments"], {"Eng": {"sections": []}})
        self.api.hub_save_config({"user": 1, "computerBase": 2, "departments": 3}, {"action": "seed"})
        r = self.api.hub_get_config()
        self.assertEqual(r["config"]["user"], 1)
        self.assertIsNone(r["seed"])                                                                    # own copy wins; template untouched
        self.assertEqual(self.api.hub_get_template_config()["config"]["departments"], {"Eng": {"sections": []}})

    def test_template_and_division_documents_are_separate(self):
        self.api.hub_save_template_config(self.CFG, {})
        self.assertIsNone(self.div_hub.get_config())

    def test_only_super_admins_write_the_template_and_it_must_look_like_a_checklist_set(self):
        self.assertFalse(self.api.hub_save_template_config({"x": 1}, {})["ok"])
        self.assertFalse(self.api.hub_save_template_config("nope", {})["ok"])
        self.gc.account_upn = "tech@nucor.com"
        self.assertIn("super admin", self.api.hub_save_template_config(self.CFG, {})["error"])
        self.assertIsNone(self.api.hub_get_template_config()["config"])                                 # reading is allowed, nothing was written

    def test_template_hub_is_bound_to_its_own_pseudo_division(self):
        self.hubmod.template_hub_for = self._orig
        h = self.hubmod.template_hub_for(self.gc)
        self.assertEqual(h.division["id"], "_template")
        self.assertEqual(h._store._div(), "_template")
        self.assertNotEqual(self.gc.division["id"], "_template")


class BgToolsDivisionList(unittest.TestCase):
    def test_every_registry_division_is_offered_once(self):
        gc = make_client()
        FakeSite(gc)
        gc.registry = [
            {"id": "nbgw", "name": "NBGW", "company_name": "Nucor Buildings Group West", "sites": []},          # already in the built-in list
            {"id": "nbgnew", "name": "NBG - New Place", "company_name": "NBG - New Place", "sites": []},
            {"id": "off", "name": "Off", "company_name": "Hidden Co", "sites": [], "enabled": False},
        ]
        api = app.Api()
        api._gc = gc
        divs = api.bg_locations()["divisions"]
        companies = [d["company"] for d in divs]
        self.assertEqual(companies.count("Nucor Buildings Group West"), 1)
        self.assertIn("NBG - New Place", companies)
        self.assertNotIn("Hidden Co", companies)


class InventoryOptions(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"super_admins": ["adm@nucor.com"]})
        FakeSite(self.gc)
        self.gc.account_upn = "adm@nucor.com"
        self.api = app.Api()
        self.api._gc = self.gc
        self.api._hub = Hub(logs_folder=tempfile.mkdtemp(), division=self.gc.division)

    def test_auto_sync_is_a_platform_setting(self):
        self.assertTrue(self.api.get_flags()["auto_sync"])
        self.gc._base_cfg["auto_sync"] = None
        self.gc._base_cfg["auto_sync"] = "off"                                    # master/config string form
        self.assertFalse(self.api.get_flags()["auto_sync"])
        self.assertEqual(sc.check_value("auto_sync", "on"), "on")
        with self.assertRaises(ValueError):
            sc.check_value("auto_sync", "maybe")

    def test_device_os_default_follows_config_then_saved_choice_wins(self):
        self.assertEqual(self.api.get_division_prefs()["device_os"], "windows")
        self.assertTrue(self.api.save_division_prefs(None, None, "all")["ok"])
        self.assertEqual(self.api.get_division_prefs()["device_os"], "all")
        self.assertFalse(self.api.save_division_prefs(None, None, "linux")["ok"])

    def test_sync_uses_the_division_device_filter(self):
        devs = [{"id": "1", "serialNumber": "W1", "operatingSystem": "Windows", "deviceName": "A", "deviceCategoryDisplayName": "NBGW"},
                {"id": "2", "serialNumber": "I1", "operatingSystem": "iOS", "deviceName": "B", "deviceCategoryDisplayName": "NBGW"}]
        self.gc._get_all = lambda url: devs
        self.gc.division_prefs = lambda: {"device_os": "windows"}
        self.assertEqual([d["serial"] for d in self.gc.get_intune_category_devices()], ["W1"])
        self.gc.division_prefs = lambda: {"device_os": "all"}
        self.assertEqual([d["serial"] for d in self.gc.get_intune_category_devices()], ["W1", "I1"])
        self.gc.division_prefs = lambda: {}                                         # nothing saved: old config.json behaviour
        self.assertEqual([d["serial"] for d in self.gc.get_intune_category_devices()], ["W1"])

    def test_hot_spare_departments(self):
        r = self.api.get_division_prefs()
        self.assertEqual((r["hot_spare_depts"], r["hot_spare_effective"]), ([], ["Detailing", "Engineering", "Other"]))
        self.assertTrue(self.api.save_division_prefs(None, None, None, ["  Fab  Shop ", "Sales", "other", "sales", ""])["ok"])
        r = self.api.get_division_prefs()
        self.assertEqual(r["hot_spare_depts"], ["Fab Shop", "Sales"])                 # tidy, no duplicates, 'Other' never listed twice
        self.assertEqual(r["hot_spare_effective"], ["Fab Shop", "Sales", "Other"])
        self.assertFalse(self.api.save_division_prefs(None, None, None, ["x" * 31])["ok"])
        self.assertFalse(self.api.save_division_prefs(None, None, None, [str(i) for i in range(13)])["ok"])
        self.assertTrue(self.api.save_division_prefs(None, None, None, [])["ok"])
        self.assertEqual(self.api.get_division_prefs()["hot_spare_effective"], ["Detailing", "Engineering", "Other"])

    def test_plain_users_cannot_change_the_options(self):
        self.gc._base_cfg["super_admins"] = []
        self.gc.account_upn = "plain@nucor.com"
        self.assertFalse(self.api.save_division_prefs(None, None, "all")["ok"])


class SearchScopes(unittest.TestCase):
    def setUp(self):
        import hub as hubmod
        self.hubmod = hubmod
        self.gc = make_client(extra={"super_admins": ["adm@nucor.com"]})
        FakeSite(self.gc)
        self.gc.account_upn = "adm@nucor.com"
        self.dir = tempfile.mkdtemp()
        self._orig = hubmod.platform_hub_for
        hubmod.platform_hub_for = lambda gc: Hub(logs_folder=self.dir, division={"id": "_platform", "name": "P", "legacy_data": False, "sites": []})
        self.api = app.Api()
        self.api._gc = self.gc

    def tearDown(self):
        self.hubmod.platform_hub_for = self._orig

    def test_defaults_until_saved_then_saved_lists_drive_bg_tools(self):
        r = self.api.get_search_scopes()
        self.assertFalse(r["custom"])
        self.assertTrue(any(b["domain"] == "americanbuildings.com" for b in r["brands"]))
        self.assertTrue(self.api.save_search_scopes({"brands": [{"label": " Acme  Steel ", "domain": "ACME.com"}],
                                                      "divisions": [{"label": "NBSIN", "company": "NBSIN"}]})["ok"])
        r = self.api.get_search_scopes()
        self.assertTrue(r["custom"])
        self.assertEqual(r["brands"], [{"label": "Acme Steel", "domain": "acme.com"}])
        loc = self.api.bg_locations()
        self.assertEqual([b["domain"] for b in loc["locations"]], ["acme.com"])
        self.assertIn("NBSIN", [d["company"] for d in loc["divisions"]])

    def test_validation(self):
        for bad in ({"brands": [{"label": "X", "domain": "not a domain"}], "divisions": []},
                    {"brands": [{"label": "", "domain": "a.com"}], "divisions": []},
                    {"brands": [], "divisions": [{"label": "L", "company": ""}]},
                    {"brands": [{"label": "A", "domain": "a%d.com" % i} for i in range(41)], "divisions": []},
                    "nope"):
            self.assertFalse(self.api.save_search_scopes(bad)["ok"], bad)
        ok = sc.clean_scopes({"brands": [{"label": "A", "domain": "a.com"}, {"label": "Dup", "domain": "A.COM"}, {"label": "", "domain": ""}], "divisions": []})
        self.assertEqual(len(ok["brands"]), 1)                                       # duplicates and blank rows dropped

    def test_super_admin_only(self):
        self.gc.account_upn = "tech@nucor.com"
        self.assertEqual(self.api.get_search_scopes(), {"ok": True, "super_admin": False})
        self.assertFalse(self.api.save_search_scopes({"brands": [], "divisions": []})["ok"])
