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

    def test_plan_only_adds_security_groups_source_has_and_destination_lacks(self):
        s = [G("A"), G("B"), G("Mail", security=False)]
        d = [G("B")]
        p = adperms.plan_copy(s, d, [G("A")["dn"], G("B")["dn"], G("Mail")["dn"], G("Other")["dn"], G("A")["dn"]])
        self.assertEqual([g["name"] for g in p["add"]], ["A"])
        self.assertEqual(sorted(x["why"] for x in p["skipped"]),
                         ["destination already in this group", "not a security group", "source user is not in this group"])

    def test_powershell_scripts_are_ascii(self):
        for ps in (adperms._READ_PS, adperms._WRITE_PS):
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


if __name__ == "__main__":
    unittest.main()
