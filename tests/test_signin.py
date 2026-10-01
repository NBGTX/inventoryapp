import unittest

import _env
from _env import make_client

import graph
import msal


@unittest.skipUnless(hasattr(msal.SerializableTokenCache, "serialize"), "needs the real msal package")
class AccountPicker(unittest.TestCase):
    def test_interactive_sign_in_always_shows_the_account_picker(self):
        seen = []

        class FakeApp:
            def __init__(self, *a, **k):
                pass

            def get_accounts(self):
                return []

            def acquire_token_interactive(self, scopes, **kw):
                seen.append(kw)
                return {"access_token": "a.b.c", "expires_in": 3600,
                        "id_token_claims": {"name": "Adm User", "preferred_username": "adm.user.azure@nucor.onmicrosoft.com"}}
        orig = graph.msal.PublicClientApplication
        graph.msal.PublicClientApplication = FakeApp
        try:
            gc = make_client()
            gc._acquire(interactive=True)
        finally:
            graph.msal.PublicClientApplication = orig
        self.assertEqual(seen[0].get("prompt"), "select_account")
        self.assertEqual(gc.account_upn, "adm.user.azure@nucor.onmicrosoft.com")

    def test_super_admin_matches_the_upn_you_actually_signed_in_with(self):
        gc = make_client(central=False, extra={"super_admins": ["adm.user.azure@nucor.onmicrosoft.com"]})
        gc.account_upn = "adm.user.azure@nucor.onmicrosoft.com"
        self.assertTrue(gc.is_super_admin())
        gc.account_upn = "user@nucor.com"
        self.assertFalse(gc.is_super_admin())


if __name__ == "__main__":
    unittest.main()
