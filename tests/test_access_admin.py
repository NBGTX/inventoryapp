import types
import unittest
from urllib.parse import unquote

import _env
from _env import FakeSite, make_client

import app
import graph


class FakeReq:
    """Captures GET urls and answers with canned Graph payloads."""

    def __init__(self, value):
        self.urls = []
        self.value = value

    def __call__(self, method, url, **kw):
        self.urls.append(url)
        v = self.value

        class R:
            def json(self_):
                return {"value": v}
        return R()


class DirectoryLookup(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        FakeSite(self.gc)

    def test_user_search_filter_is_escaped_and_returns_small_dicts(self):
        req = FakeReq([{"id": "1", "displayName": "Sims Anderson", "userPrincipalName": "ADM.Sanderson.Azure@nucor.onmicrosoft.com",
                        "companyName": "NBT", "mail": "secret@x"}])
        self.gc._req = req
        out = self.gc.directory_lookup("adm.o'brien")
        url = unquote(req.urls[0])
        self.assertIn("startswith(userPrincipalName,'adm.o''brien')", url)      # quote doubled, not injectable
        self.assertEqual(out, [{"kind": "user", "id": "1", "name": "Sims Anderson",
                                "upn": "adm.sanderson.azure@nucor.onmicrosoft.com", "detail": "NBT"}])

    def test_group_search(self):
        req = FakeReq([{"id": "g1", "displayName": "NBG Hub Users", "description": "x" * 200}])
        self.gc._req = req
        out = self.gc.directory_lookup("NBG", "group")
        self.assertIn("/groups?", req.urls[0])
        self.assertEqual((out[0]["kind"], out[0]["id"], out[0]["name"]), ("group", "g1", "NBG Hub Users"))
        self.assertEqual(len(out[0]["detail"]), 70)

    def test_short_queries_do_not_call_graph(self):
        self.gc._req = lambda *a, **k: self.fail("graph called")
        self.assertEqual(self.gc.directory_lookup("a"), [])
        self.assertEqual(self.gc.directory_lookup("  "), [])


class SuperAdminManagement(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"super_admins": ["boot@nucor.com"]})
        self.site = FakeSite(self.gc)
        self.site.add("master_settings", Title="super_admins", Value="a@nucor.com; b@nucor.com", Secret="No")
        self.gc.account_upn = "boot@nucor.com"
        self.api = app.Api()
        self.api._gc = self.gc

    def test_list_shows_editable_and_bootstrap(self):
        r = self.api.get_super_admins()
        self.assertEqual((r["admins"], r["bootstrap"], r["me"]), (["a@nucor.com", "b@nucor.com"], ["boot@nucor.com"], "boot@nucor.com"))

    def test_save_validates_dedupes_and_writes_the_master_row(self):
        r = self.api.save_super_admins(["A@nucor.com", "a@nucor.com", "c@nucor.com"])
        self.assertTrue(r["ok"])
        self.assertEqual(r["admins"], ["a@nucor.com", "c@nucor.com"])
        patch = [s for s in self.site.sent if s[0] == "PATCH"][-1][2]
        self.assertEqual(patch[_env.DEFAULT_COLS["value"]], "a@nucor.com, c@nucor.com")

    def test_rejects_non_emails(self):
        r = self.api.save_super_admins(["not an email"])
        self.assertFalse(r["ok"])
        self.assertIn("not a sign-in email", r["error"])

    def test_cannot_remove_yourself_unless_you_are_in_config(self):
        self.gc._base_cfg["super_admins"] = []
        self.gc.account_upn = "a@nucor.com"
        self.gc._master_cache = None
        r = self.api.save_super_admins(["b@nucor.com"])
        self.assertFalse(r["ok"])
        self.assertIn("cannot remove yourself", r["error"])
        self.assertTrue(self.api.save_super_admins(["a@nucor.com", "b@nucor.com"])["ok"])

    def test_config_admins_can_prune_the_list_but_stay_admins(self):
        self.assertTrue(self.api.save_super_admins([])["ok"])             # boot@ is in config.json: still admin
        self.assertTrue(self.gc.is_super_admin())

    def test_non_admins_get_nothing_and_cannot_save_or_search(self):
        self.gc.account_upn = "nobody@nucor.com"
        self.assertEqual(self.api.get_super_admins(), {"ok": True, "super_admin": False})
        self.assertFalse(self.api.save_super_admins(["x@nucor.com"])["ok"])
        self.gc._req = lambda *a, **k: self.fail("graph called")
        self.assertEqual(self.api.user_lookup("anything"), {"ok": True, "results": []})


class GroupAccess(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        self.site = FakeSite(self.gc)
        self.gc.account_upn = "user@nucor.com"
        self.gc.registry[0]["access"] = ["*"]                          # NBGW open to everyone for these tests
        self.gc.registry.append({"id": "nbgtx", "name": "TX", "company_name": "c", "sites": [], "lists": {}, "legacy_data": False,
                                 "access": ["group:ABC-123|NBGTX IT", "someone@else.com"]})

    def ids(self):
        return sorted(d["id"] for d in self.gc.visible_registry())

    def test_group_member_sees_the_division(self):
        self.gc._get_all = lambda url: [{"id": "abc-123"}, {"id": "other"}]
        self.assertEqual(self.ids(), ["nbgtx", "nbgw"])

    def test_non_member_does_not(self):
        self.gc._get_all = lambda url: [{"id": "other"}]
        self.assertEqual(self.ids(), ["nbgw"])

    def test_group_lookup_failure_fails_closed_and_group_names_do_not_grant_access(self):
        def boom(url):
            raise RuntimeError("graph down")
        self.gc._get_all = boom
        self.assertEqual(self.ids(), ["nbgw"])
        self.gc._get_all = lambda url: [{"id": "nbgtx it"}]            # a group whose NAME equals the label: no access
        self.gc._grp_cache = None
        self.assertEqual(self.ids(), ["nbgw"])

    def test_groups_are_only_fetched_when_an_acl_names_one(self):
        self.gc.registry[-1]["access"] = ["someone@else.com"]
        self.gc._get_all = lambda url: self.fail("group lookup not needed")
        self.assertEqual(self.ids(), ["nbgw"])

    def test_saved_access_keeps_group_display_names_and_lowercases_emails(self):
        self.gc._base_cfg["super_admins"] = ["user@nucor.com"]
        self.gc.save_division_row({"id": "nbgtx", "name": "TX", "company_name": "c", "intune_category": "i", "sites": [],
                                   "access": ["User@Nucor.com", "group:ABC-123|NBGTX IT", "user@nucor.com"]})
        post = [s for s in self.site.sent if s[0] == "POST"][-1][2]["fields"]
        self.assertEqual(post["AccessJson"], '["user@nucor.com", "group:ABC-123|NBGTX IT"]')


if __name__ == "__main__":
    unittest.main()
