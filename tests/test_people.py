import unittest

import _env                     # noqa: F401

import sync


class FakeGC:
    """Just enough of GraphClient for build_people."""
    _has_authmethod_read = False

    def __init__(self, rows):
        self.rows = rows

    def _items_raw(self, kind):
        return [{"id": str(i), "fields": r} for i, r in enumerate(self.rows)]

    def _row(self, f, kind, in_use=False):
        return {"serial": f["Title"], "device_name": f.get("name", ""), "user": f.get("user", "")}

    def mfa_status(self, upn, mmap=None):
        info = (mmap or {}).get((upn or "").strip().lower())
        return ("Yes" if info["registered"] else "No") if info else None


class BuildPeople(unittest.TestCase):
    def test_one_row_per_person_with_all_their_devices(self):
        gc = FakeGC([{"Title": "S1", "name": "PC1", "user": "A@nucor.com"}, {"Title": "S2", "name": "PC2", "user": "a@nucor.com"},
                     {"Title": "S3", "name": "PC3", "user": "b@nucor.com"}, {"Title": "S4", "name": "PC4", "user": ""}])
        m = {"a@nucor.com": {"registered": True, "name": "Ann", "methods": ["fido2"], "default": "fido2", "updated": "2026-09-01"},
             "b@nucor.com": {"registered": False}}
        d = sync.build_people(gc, m)
        self.assertEqual([p["user"].lower() for p in d["people"]], ["a@nucor.com", "b@nucor.com"])
        a, b = d["people"]
        self.assertEqual([x["serial"] for x in a["devices"]], ["S1", "S2"])        # same person on two machines is one row
        self.assertEqual((a["mfa"], a["name"], a["methods"]), ("Yes", "Ann", ["fido2"]))
        self.assertEqual(b["mfa"], "No")
        self.assertEqual((d["yes"], d["no"], d["unknown"], d["source"]), (1, 1, 0, "report"))

    def test_unknown_when_entra_has_nothing(self):
        d = sync.build_people(FakeGC([{"Title": "S1", "user": "x@nucor.com"}]), {})
        self.assertEqual((d["people"][0]["mfa"], d["unknown"], d["source"]), ("", 1, "none"))


class MailLink(unittest.TestCase):
    def test_builds_a_safe_draft_link(self):
        import app
        u = app.Api._mailto_url(["a@nucor.com", "b.c@nucor.com"], "Hi there & more", "Line one\nLine two")
        self.assertTrue(u.startswith("mailto:a@nucor.com,b.c@nucor.com?subject=Hi%20there%20%26%20more&body=Line%20one%0ALine%20two"))

    def test_refuses_bad_or_too_many_addresses(self):
        import app
        for bad in (["not-an-email"], ["a@b"], ["a@nucor.com;evil@x.com"], ["a b@nucor.com"], []):
            with self.assertRaises(ValueError, msg=str(bad)):
                app.Api._mailto_url(bad, "s", "b")
        with self.assertRaises(ValueError) as cm:
            app.Api._mailto_url([f"user{i}@nucor.com" for i in range(300)], "s", "b")
        self.assertIn("Too many", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
