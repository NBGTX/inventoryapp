import unittest

import _env                     # noqa: F401
from _env import FakeSite, make_client

import adperms
import app


def G(name, **kw):
    return {"dn": f"CN={name},OU=G,DC=bg", "name": name, "desc": "", "security": True, "privileged": False, **kw}


class Pure(unittest.TestCase):
    def test_compare_splits_by_dn_case_insensitive(self):
        s = [G("A"), G("B"), G("C")]
        d = [{**G("b"), "dn": G("B")["dn"].upper()}, G("D")]
        c = adperms.compare(s, d)
        self.assertEqual([g["name"] for g in c["only_src"]], ["A", "C"])
        self.assertEqual([g["name"] for g in c["only_dst"]], ["D"])
        self.assertEqual([g["name"] for g in c["both"]], ["B"])

    def test_plan_only_adds_groups_source_has_and_destination_lacks(self):
        s = [G("A"), G("B"), G("Mail", security=False)]
        d = [G("B")]
        p = adperms.plan_copy(s, d, [G("A")["dn"], G("B")["dn"], G("Mail")["dn"], G("Other")["dn"], G("A")["dn"]])
        self.assertEqual([g["name"] for g in p["add"]], ["A", "Mail"])          # distribution lists copy like any group
        self.assertEqual(sorted(x["why"] for x in p["skipped"]),
                         ["destination already in this group", "source user is not in this group"])

    def test_scope_keeps_division_and_blank_company_admin_accounts(self):
        us = [{"company": "NBG - Terrell"}, {"company": "nbg - terrell"}, {"company": ""}, {"company": "NBG - West"}]
        self.assertEqual(len([u for u in us if adperms.in_scope(u, ["NBG - Terrell", "Other"])]), 3)

    def test_scinfo_hashes_ignore_the_windows_hello_reader(self):
        txt = chr(10).join(["--- Reader: Windows Hello for Business 1", "Cert Hash(sha1): " + "a" * 40,
                            "--- Reader: Yubico YubiKey OTP+FIDO+CCID 0", "Cert Hash(sha1): CB7B4E020AF1435D03C57AD0B66CC3A1C8F4E430"])
        got = adperms.parse_scinfo(txt)
        self.assertIn("cb7b4e020af1435d03c57ad0b66cc3a1c8f4e430", got)
        self.assertNotIn("a" * 40, got)

    def test_write_needs_the_account_to_be_on_the_inserted_key(self):
        o = adperms.smartcard_accounts
        adperms.smartcard_accounts = lambda timeout=30: {"accounts": [{"upn": "adm.x.pa@nucorsteel.local", "thumb": "00" * 20}]}
        try:
            r = adperms.write_groups("CN=U", ["CN=G"], "bg", "someone.else@nucorsteel.local")
        finally:
            adperms.smartcard_accounts = o
        self.assertIn("not found on the inserted YubiKey", r["__error__"])

    def test_powershell_scripts_are_ascii(self):
        for ps in (adperms._READ_PS, adperms._WRITE_PS, adperms._CERTS_PS):
            ps.encode("ascii")

    def test_single_item_json_becomes_list(self):
        self.assertEqual(adperms._listify({"a": 1}), [{"a": 1}])
        self.assertEqual(adperms._listify(None), [])


class ApiFlow(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        FakeSite(self.gc)
        self.gc.sign_in = lambda interactive=False: ""
        self.api = app.Api()
        self.api._gc = self.gc
        self.gc.account_upn, self.gc.account_name = "boss@nucor.com", "Boss"
        self.src_dn, self.dst_dn = "CN=Src,DC=bg", "CN=Dst,DC=bg"
        self.groups = {self.src_dn: [G("A"), G("B"), G("Admins", privileged=True)], self.dst_dn: [G("B")]}
        self.writes = []
        self._o = (adperms.user_groups, adperms.write_groups)
        adperms.user_groups = lambda dn, domain: {"groups": list(self.groups[dn])}

        def fake_write(user_dn, dns, domain, account="", timeout=300):
            self.writes.append((user_dn, list(dns), account))
            self.groups[user_dn] += [g for g in self.groups[self.src_dn] if g["dn"] in dns]
            return {"done": list(dns), "failed": [], "who": "BG\\adm.x.pa"}
        adperms.write_groups = fake_write

    def tearDown(self):
        adperms.user_groups, adperms.write_groups = self._o

    def test_compare(self):
        r = self.api.ad_perm_compare(self.src_dn, self.dst_dn)
        self.assertTrue(r["ok"], r)
        self.assertEqual([g["name"] for g in r["only_src"]], ["A", "Admins"])
        self.assertFalse(self.api.ad_perm_compare(self.src_dn, self.src_dn)["ok"])

    def test_dry_run_writes_nothing_and_commit_verifies(self):
        dns = [G("A")["dn"]]
        r = self.api.ad_perm_copy(self.src_dn, self.dst_dn, dns, "adm.x.pa", False)
        self.assertEqual((r["ok"], r["committed"], r["would_add"]), (True, False, ["A"]))
        self.assertEqual(self.writes, [])
        r = self.api.ad_perm_copy(self.src_dn, self.dst_dn, dns + [G("B")["dn"]], "adm.x.pa", True)
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["added"], r["unverified"], r["failed"]), (["A"], [], []))
        self.assertEqual(self.writes, [(self.dst_dn, dns, "adm.x.pa")])

    def test_failed_and_unconfirmed_are_reported(self):
        adperms.write_groups = lambda u, d, dom, a="", timeout=300: {"done": [], "failed": [{"dn": d[0], "error": "Access denied"}], "who": "x"}
        r = self.api.ad_perm_copy(self.src_dn, self.dst_dn, [G("A")["dn"]], "", True)
        self.assertEqual(r["failed"], [{"name": "A", "error": "Access denied"}])
        adperms.write_groups = lambda u, d, dom, a="", timeout=300: {"done": list(d), "failed": [], "who": "x"}
        r = self.api.ad_perm_copy(self.src_dn, self.dst_dn, [G("A")["dn"]], "", True)
        self.assertEqual(r["unverified"], ["A"])

    def test_needs_admin_and_a_selection(self):
        self.assertFalse(self.api.ad_perm_copy(self.src_dn, self.dst_dn, [], "", True)["ok"])
        self.gc.account_upn = "tech@nucor.com"
        r = self.api.ad_perm_copy(self.src_dn, self.dst_dn, [G("A")["dn"]], "", True)
        self.assertFalse(r["ok"])
        self.assertEqual(self.writes, [])
        self.assertFalse(self.api.ad_user_search("ab")["ok"])

    def test_local_mode_blocks_the_write(self):
        self.gc.data_mode = "local"
        r = self.api.ad_perm_copy(self.src_dn, self.dst_dn, [G("A")["dn"]], "", True)
        self.assertFalse(r["ok"])
        self.assertEqual(self.writes, [])


class MyPrefs(unittest.TestCase):
    def setUp(self):
        import tempfile
        import hub as hubmod
        from hub import Hub
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        FakeSite(self.gc)
        self.gc.sign_in = lambda interactive=False: ""
        self.gc.account_upn, self.gc.account_name = "boss@nucor.com", "Boss"
        self.dir = tempfile.mkdtemp()
        self._orig = hubmod.platform_hub_for
        hubmod.platform_hub_for = lambda gc: Hub(logs_folder=self.dir, division={"id": "_platform", "name": "P", "legacy_data": False, "sites": []})
        self.hubmod = hubmod
        self.api = app.Api()
        self.api._gc = self.gc

    def tearDown(self):
        self.hubmod.platform_hub_for = self._orig

    def test_default_division_is_saved_per_person_and_validated(self):
        ids = [d["id"] for d in self.gc.visible_registry()]
        self.assertTrue(ids)
        self.assertTrue(self.api.save_my_prefs(ids[-1])["ok"])
        self.assertEqual(self.api.get_my_prefs()["default_division"], ids[-1])
        self.assertFalse(self.api.save_my_prefs("nope")["ok"])
        self.gc.account_upn = "other@nucor.com"
        self.assertEqual(self.api.get_my_prefs()["default_division"], "")        # someone else's choice is theirs alone
        self.gc.account_upn = "boss@nucor.com"
        self.assertTrue(self.api.save_my_prefs("")["ok"])
        self.assertEqual(self.api.get_my_prefs()["default_division"], "")


class Catalog(unittest.TestCase):
    def test_domain_controller_setting_accepts_a_server_name_only(self):
        import settings_catalog as sc
        self.assertEqual(sc.check_value("ad_domain_controller", " BGDALDCRW02.bg.nucorsteel.local "), "BGDALDCRW02.bg.nucorsteel.local")
        self.assertEqual(sc.check_value("ad_domain_controller", ""), "")
        with self.assertRaises(ValueError):
            sc.check_value("ad_domain_controller", "bad name; rm -rf")


if __name__ == "__main__":
    unittest.main()
