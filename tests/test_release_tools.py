import json
import os
import re
import sys
import tempfile
import unittest

import _env                     # noqa: F401  (puts the project on sys.path)
from _env import FakeSite, make_client

import app
import graph
import selftest
import settings_catalog as sc
import version

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import check_release            # noqa: E402


class ShippedConfigScan(unittest.TestCase):
    GOOD = {"tenant_id": "t", "client_id": "c", "central": {"site_path": "/sites/x"}, "super_admins": ["a@b.com"]}

    def test_clean_config_passes(self):
        self.assertEqual(check_release.scan(self.GOOD), [])

    def test_missing_and_placeholder_values_fail(self):
        self.assertTrue(check_release.scan({"tenant_id": "PASTE-ME", "client_id": "c", "central": {"a": 1}}))
        self.assertTrue(check_release.scan({"tenant_id": "t", "client_id": "c"}))          # no central

    def test_secret_looking_values_fail_but_identifiers_do_not(self):
        bad = dict(self.GOOD, lenovo_client_id="REAL", nested={"api_key": "x"})
        found = " ".join(check_release.scan(bad))
        self.assertIn("lenovo_client_id", found)
        self.assertIn("nested.api_key", found)
        self.assertNotIn("tenant_id", found)
        self.assertEqual(check_release.scan(dict(self.GOOD, lenovo_client_id="")), [])     # blank is fine

    def test_strip_secrets_removes_them_without_changing_the_input(self):
        src = dict(self.GOOD, lenovo_client_id="REAL", client_secret="s")
        clean, removed = check_release.strip_secrets(src)
        self.assertEqual(sorted(removed), ["client_secret", "lenovo_client_id"])
        self.assertNotIn("lenovo_client_id", clean)
        self.assertIn("lenovo_client_id", src)
        self.assertEqual(check_release.scan(clean), [])

    def test_cli_writes_a_scrubbed_copy_and_never_touches_the_original(self):
        d = tempfile.mkdtemp()
        src, out = os.path.join(d, "config.json"), os.path.join(d, "sub", "release.json")
        with open(src, "w") as f:
            json.dump(dict(self.GOOD, lenovo_client_id="REAL"), f)
        self.assertEqual(check_release.main(["x", src, "--write", out]), 0)
        self.assertNotIn("lenovo_client_id", json.load(open(out)))
        self.assertIn("lenovo_client_id", json.load(open(src)))
        self.assertEqual(check_release.main(["x", src]), 1)                                # unscrubbed original fails the scan


class LayeredConfig(unittest.TestCase):
    def write(self, d, name, data):
        p = os.path.join(d, name)
        with open(p, "w") as f:
            json.dump(data, f)
        return p

    def test_user_override_wins_and_nested_objects_merge(self):
        d = tempfile.mkdtemp()
        base = self.write(d, "base.json", {"tenant_id": "t", "client_id": "c", "central": {"site_host": "h", "site_path": "/p"}, "x": 1})
        over = self.write(d, "over.json", {"x": 2, "central": {"site_path": "/other"}})
        cfg = graph.load_config(base, over)
        self.assertEqual((cfg["x"], cfg["central"]), (2, {"site_host": "h", "site_path": "/other"}))

    def test_explicit_path_alone_ignores_any_real_user_override(self):
        d = tempfile.mkdtemp()
        base = self.write(d, "base.json", {"tenant_id": "t", "client_id": "c"})
        self.assertEqual(graph.load_config(base), {"tenant_id": "t", "client_id": "c"})

    def test_override_only_install_works_and_bad_json_is_explained(self):
        d = tempfile.mkdtemp()
        over = self.write(d, "over.json", {"tenant_id": "t", "client_id": "c"})
        self.assertEqual(graph.load_config(os.path.join(d, "none.json"), over)["tenant_id"], "t")
        bad = os.path.join(d, "bad.json")
        with open(bad, "w") as f:
            f.write("{oops")
        with self.assertRaises(graph.GraphError) as cm:
            graph.load_config(bad, "")
        self.assertIn("not valid JSON", str(cm.exception))


class UpdateInfo(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        FakeSite(self.gc)
        self.api = app.Api()
        self.api._gc = self.gc

    def test_version_parse_and_order(self):
        self.assertEqual(version.parse("2026.10.01"), (2026, 10, 1, 0))
        self.assertLess(version.parse("2026.10.01"), version.parse("2026.10.01.2"))
        self.assertLess(version.parse("2026.9.30"), version.parse("2026.10.1"))
        for bad in ("", "x", "2026.10", "2026.10.1.2.3", "2026.10.a"):
            self.assertEqual(version.parse(bad), ())

    def test_flags(self):
        cur = version.APP_VERSION
        self.assertEqual(self.api.get_update_info()["update_available"], False)
        self.gc._base_cfg["latest_version"] = "2999.01.01"
        self.gc._base_cfg["min_version"] = "2999.01.01"
        r = self.api.get_update_info()
        self.assertTrue(r["update_available"] and r["update_required"])
        self.gc._base_cfg["latest_version"] = cur
        self.gc._base_cfg["min_version"] = "2000.01.01"
        r = self.api.get_update_info()
        self.assertFalse(r["update_available"] or r["update_required"])
        self.gc._base_cfg["latest_version"] = "garbage"                                   # ignored, never crashes
        self.assertEqual(self.api.get_update_info()["latest"], "")

    def test_catalog_validates_versions(self):
        self.assertEqual(sc.check_value("latest_version", " 2026.10.15 "), "2026.10.15")
        self.assertEqual(sc.check_value("min_version", ""), "")
        with self.assertRaises(ValueError):
            sc.check_value("latest_version", "next week")


class PackagingGuards(unittest.TestCase):
    def read(self, rel):
        with open(os.path.join(ROOT, rel), "rb") as f:
            return f.read()

    def test_every_selftest_module_that_is_ours_exists(self):
        third_party = {"msal", "requests", "truststore", "webview", "clr", "clr_loader", "cffi"}
        for m in selftest.MODULES:
            if m not in third_party:
                self.assertTrue(os.path.isfile(os.path.join(ROOT, m + ".py")), m)

    def test_every_local_module_the_app_imports_is_in_selftest(self):
        local = {f[:-3] for f in os.listdir(ROOT) if f.endswith(".py") and f not in ("conftest.py",)}
        imported = set()
        for f in ("app.py", "graph.py", "sync.py", "hub.py", "hubstore.py", "localstore.py", "divisions.py"):
            src = self.read(f).decode("utf-8")
            imported |= {m for m in re.findall(r"^\s*(?:from|import)\s+([a-z_]+)", src, re.M) if m in local}
        missing = sorted(imported - set(selftest.MODULES) - {"cpu"})
        self.assertEqual(missing, [], "add these to selftest.MODULES so the build bundles and tests them")

    def test_build_script_is_ascii_and_has_no_personal_paths(self):
        raw = self.read("build.ps1")
        raw.decode("ascii")
        self.assertNotIn(b"Blake", raw)
        self.assertNotIn(b"C:\\Users\\", raw)

    def test_installer_script_basics(self):
        iss = self.read("installer/NBG-Hub.iss").decode("utf-8")
        for needle in ("PrivilegesRequired=lowest", "AppId=", "CloseApplications=yes", "NeedsWebView2", "/silent /install",
                       "F3017226-FE2A-4295-8BDF-00C3A9A7E4C5"):
            self.assertIn(needle, iss)
        self.assertNotIn("{pf}", iss)                                                    # never machine-wide

    def test_web_files_listed_by_selftest_exist(self):
        for f in selftest.WEB_FILES:
            self.assertTrue(os.path.isfile(os.path.join(ROOT, "web", f)), f)

    def test_webview2_detection_returns_a_string(self):
        self.assertIsInstance(selftest.webview2_version(), str)

    def test_selftest_run_passes_in_the_dev_environment(self):
        try:
            import webview  # noqa: F401
            import clr      # noqa: F401
        except Exception:
            self.skipTest("pywebview/pythonnet not installed in this Python")
        out = os.path.join(tempfile.mkdtemp(), "r.txt")
        self.assertEqual(selftest.run(out), 0, open(out).read())
        self.assertIn("RESULT PASS", open(out).read())


if __name__ == "__main__":
    unittest.main()


class SingleSiteDivision(unittest.TestCase):
    def test_one_site_takes_every_device_and_city(self):
        import divisions
        d = {"sites": [{"code": "ter", "city_prefixes": ["terrell"], "device_prefixes": ["BGTER"]}]}
        for name in ("BGTERLT1", "DETMZ-01", "TEREN9", "", "anything"):
            self.assertEqual(divisions.site_from_name(d, name), "TER")
        for city in ("Terrell", "Dallas", ""):
            self.assertEqual(divisions.city_to_site(d, city), "TER")

    def test_two_or_more_sites_still_need_a_match(self):
        import divisions
        d = divisions.load_registry({})[0]
        self.assertEqual(divisions.site_from_name(d, "XYZ"), "")
        self.assertEqual(divisions.city_to_site(d, "Nowhere"), "")
        self.assertEqual(divisions.site_from_name({"sites": []}, "X"), "")


class VendorLookups(unittest.TestCase):
    """Dell/HP lookups with a fake `requests` (no network, no keys)."""

    def setUp(self):
        import vendors
        self.v = vendors
        self.v.clear_tokens()
        self.calls = []
        outer = self

        class R:
            def __init__(s, payload, status=200):
                s._p, s.status_code, s.ok = payload, status, status < 400

            def json(s):
                return s._p

        def post(url, **kw):
            outer.calls.append(("POST", url, kw))
            if "token" in url:
                return R({"access_token": "TOK", "expires_in": 3600})
            return R(outer.hp_payload)

        def get(url, **kw):
            outer.calls.append(("GET", url, kw))
            return R(outer.dell_payload, outer.dell_status)
        self._orig = (self.v.requests.post, self.v.requests.get)
        self.v.requests.post, self.v.requests.get = post, get
        self.dell_status = 200
        self.dell_payload = [{"serviceTag": "ABC1234", "systemDescription": "Dell Latitude 5420", "invalid": False,
                              "entitlements": [{"endDate": "2024-05-01T05:59:59.999Z"}, {"endDate": "2026-05-01T05:59:59.999Z"}]}]
        self.hp_payload = [{"sn": "5CG1", "product": {"productName": "HP EliteBook 840 G8"},
                            "offers": [{"offerEndDate": "2025-01-31", "description": "Next business day"}, {"offerEndDate": "2027-01-31"}]}]

    def tearDown(self):
        self.v.requests.post, self.v.requests.get = self._orig
        self.v.clear_tokens()

    def test_vendor_of(self):
        for m, want in (("Lenovo", "lenovo"), ("LENOVO", "lenovo"), ("Dell Inc.", "dell"), ("HP", "hp"), ("Hewlett-Packard", "hp"),
                        ("HP Inc.", "hp"), ("Microsoft Corporation", ""), ("", ""), (None, "")):
            self.assertEqual(self.v.vendor_of(m), want, m)

    def test_dell_returns_model_and_latest_warranty_end(self):
        r = self.v.lookup_dell("id", "secret", "ABC1234")
        self.assertEqual((r["model"], r["warranty_end"], r["cpu"]), ("Latitude 5420", "2026-05-01", ""))
        get = [c for c in self.calls if c[0] == "GET"][0]
        self.assertEqual(get[2]["params"], {"servicetags": "ABC1234"})
        self.assertEqual(get[2]["headers"]["Authorization"], "Bearer TOK")
        tok = [c for c in self.calls if c[1] == self.v.DELL_TOKEN_URL][0]
        self.assertEqual(tok[2]["data"]["grant_type"], "client_credentials")

    def test_token_is_reused_between_lookups(self):
        self.v.lookup_dell("id", "secret", "A")
        self.v.lookup_dell("id", "secret", "B")
        self.assertEqual(len([c for c in self.calls if c[1] == self.v.DELL_TOKEN_URL]), 1)

    def test_dell_missing_keys_invalid_tag_and_errors_return_none(self):
        self.assertIsNone(self.v.lookup_dell("", "s", "A"))
        self.assertIsNone(self.v.lookup_dell("i", "", "A"))
        self.assertIsNone(self.v.lookup_dell("i", "s", ""))
        self.assertEqual(self.calls, [])
        self.dell_payload = [{"invalid": True}]
        self.assertIsNone(self.v.lookup_dell("i", "s", "BAD"))
        self.dell_status = 500
        self.assertIsNone(self.v.lookup_dell("i", "s", "A"))
        self.v.requests.get = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("net down"))
        self.assertIsNone(self.v.lookup_dell("i", "s", "A"))                # never raises

    def test_hp_tolerant_parser(self):
        r = self.v.lookup_hp("key", "secret", "5CG1")
        self.assertEqual((r["model"], r["warranty_end"]), ("HP EliteBook 840 G8", "2027-01-31"))
        post = [c for c in self.calls if c[1] == self.v.HP_QUERIES_URL][0]
        self.assertEqual(post[2]["json"], [{"sn": "5CG1"}])
        self.assertIsNone(self.v.parse_hp({"nothing": "useful"}))
        self.assertIsNone(self.v.parse_hp(None))

    def test_graph_routes_by_manufacturer(self):
        gc = make_client(extra={"dell_client_id": "i", "dell_client_secret": "s", "hp_client_id": "k", "hp_client_secret": "z"})
        FakeSite(gc)
        self.assertEqual(gc.lookup_vendor("ABC1234", "Dell Inc.")["warranty_end"], "2026-05-01")
        self.assertEqual(gc.lookup_vendor("5CG1", "HP")["model"], "HP EliteBook 840 G8")
        self.assertIsNone(gc.lookup_vendor("X", "Microsoft Corporation"))
        gc2 = make_client()
        FakeSite(gc2)
        self.assertIsNone(gc2.lookup_vendor("ABC1234", "Dell"))             # no keys saved: quietly nothing
