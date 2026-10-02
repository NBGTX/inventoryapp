import unittest

import _env                     # noqa: F401
from _env import FakeSite, make_client

import app


class DataModeAccess(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        FakeSite(self.gc)
        self.gc.sign_in = lambda interactive=False: ""
        self.gc.account_upn, self.gc.account_name = "tech@nucor.com", "Tech"
        self.set_calls = []
        self.gc.set_data_mode = lambda mode: self.set_calls.append(mode) or mode
        self.api = app.Api()
        self.api._gc = self.gc

    def test_only_super_admins_can_go_local_or_copy_production(self):
        self.assertEqual(self.api.get_data_mode()["can_switch"], False)
        r = self.api.set_data_mode("local")
        self.assertFalse(r["ok"])
        self.assertIn("super admin", r["error"])
        self.assertFalse(self.api.pull_prod_snapshot()["ok"])
        self.assertEqual(self.set_calls, [])
        self.assertTrue(self.api.set_data_mode("live")["ok"])                     # back to Live is always allowed
        self.assertEqual(self.set_calls, ["live"])

    def test_super_admin_can(self):
        self.gc.account_upn = "boss@nucor.com"
        self.assertEqual(self.api.get_data_mode()["can_switch"], True)
        self.assertTrue(self.api.set_data_mode("local")["ok"])
        self.assertEqual(self.set_calls, ["local"])


if __name__ == "__main__":
    unittest.main()
