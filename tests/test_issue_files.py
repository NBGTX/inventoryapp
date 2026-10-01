import base64
import os
import tempfile
import unittest

import _env                     # noqa: F401
from _env import FakeSite, make_client

import app
import hub as hubmod
import issues
import notify
from hub import Hub

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 40
JPG = b"\xff\xd8\xff\xe0" + b"1" * 40
PDF = b"%PDF-1.4\n" + b"2" * 40


def b64(b):
    return base64.b64encode(b).decode()


def f(name, data):
    return {"name": name, "data": b64(data)}


class Validation(unittest.TestCase):
    def test_accepts_the_listed_types_and_cleans_the_name(self):
        n, mime, data = issues.check_attachment("..\\evil/dir\\My Shot (1).PNG", b64(PNG))
        self.assertEqual((n, mime, data), ("My Shot _1_.PNG", "image/png", PNG))
        self.assertEqual(issues.check_attachment("a.jpeg", b64(JPG))[1], "image/jpeg")
        self.assertEqual(issues.check_attachment("a.pdf", b64(PDF))[1], "application/pdf")
        self.assertEqual(issues.check_attachment("notes.log", b64(b"line one\nline two"))[1], "text/plain")
        self.assertEqual(issues.check_attachment("w.webp", b64(b"RIFF\x00\x00\x00\x00WEBPVP8 xx"))[1], "image/webp")

    def test_refuses_programs_archives_fakes_and_junk(self):
        for name, data, why in (("x.exe", b"MZ" + b"0" * 30, "not accepted"), ("x.zip", b"PK\x03\x04" + b"0" * 30, "not accepted"),
                                ("x.ps1", b"calc", "not accepted"), ("noext", b"abc", "not accepted"),
                                ("fake.png", b"MZ" + b"0" * 30, "not really"), ("fake.pdf", b"hello", "not really"),
                                ("bin.txt", b"abc\x00def", "not a text"), ("e.png", b"", "empty")):
            with self.assertRaises(issues.IssueError, msg=name) as cm:
                issues.check_attachment(name, b64(data))
            self.assertIn(why, str(cm.exception))
        with self.assertRaises(issues.IssueError):
            issues.check_attachment("a.png", "!!!not base64!!!")
        with self.assertRaises(issues.IssueError) as cm:
            issues.check_attachment("big.png", b64(b"\x89PNG\r\n\x1a\n" + b"0" * (issues.MAX_BYTES + 1)))
        self.assertIn("too big", str(cm.exception))


class Board(unittest.TestCase):
    def setUp(self):
        self.gc = make_client(extra={"super_admins": ["boss@nucor.com"]})
        FakeSite(self.gc)
        self.gc.sign_in = lambda interactive=False: ""
        self.dir = tempfile.mkdtemp()
        self._orig = hubmod.platform_hub_for
        hubmod.platform_hub_for = lambda gc: Hub(logs_folder=self.dir, division={"id": "_platform", "name": "P", "legacy_data": False, "sites": []})
        self.api = app.Api()
        self.api._gc = self.gc
        self.api._sync_notify = True
        self._od = notify.deliver
        notify.deliver = lambda *a, **k: {"sent": 0, "via": "", "error": ""}
        self.gc.account_upn, self.gc.account_name = "tech@nucor.com", "Tech"

    def tearDown(self):
        hubmod.platform_hub_for = self._orig
        notify.deliver = self._od

    def files_on_disk(self):
        out = []
        for root, _, names in os.walk(self.dir):
            out += [n for n in names if not n.endswith(".tmp") and "attachments" in root]
        return out

    def test_report_with_a_pasted_screenshot_and_read_it_back(self):
        r = self.api.issue_create("bug", "Broken", "see picture", [f("screenshot.png", PNG)])
        self.assertTrue(r["ok"], r)
        iid = r["issue"]["id"]
        self.assertEqual(r["issue"]["files"], 1)
        meta = self.api.issue_get(iid)["issue"]["attachments"][0]
        self.assertEqual((meta["name"], meta["type"], meta["size"]), ("screenshot.png", "image/png", len(PNG)))
        got = self.api.issue_attachment(iid, meta["id"])
        self.assertTrue(got["ok"])
        self.assertEqual(base64.b64decode(got["data"]), PNG)
        self.assertEqual(len(self.files_on_disk()), 1)

    def test_comment_with_only_a_file_is_allowed_but_empty_is_not(self):
        iid = self.api.issue_create("bug", "B")["issue"]["id"]
        self.assertFalse(self.api.issue_comment(iid, "   ")["ok"])
        r = self.api.issue_comment(iid, "", [f("log.txt", b"error 5"), f("p.pdf", PDF)])
        self.assertTrue(r["ok"], r)
        c = self.api.issue_get(iid)["issue"]["comments"][0]
        self.assertEqual([a["name"] for a in c["attachments"]], ["log.txt", "p.pdf"])
        self.assertEqual(self.api.issues_list()["issues"][0]["files"], 2)

    def test_a_bad_file_rejects_the_whole_post_and_uploads_nothing(self):
        r = self.api.issue_create("bug", "B", "", [f("ok.png", PNG), f("bad.exe", b"MZ" + b"0" * 30)])
        self.assertFalse(r["ok"])
        self.assertIn("not accepted", r["error"])
        self.assertEqual(self.files_on_disk(), [])
        self.assertEqual(self.api.issues_list()["issues"], [])

    def test_limits_per_post_and_per_issue(self):
        six = [f(f"s{i}.png", PNG) for i in range(6)]
        self.assertIn("At most 5", self.api.issue_create("bug", "B", "", six)["error"])
        iid = self.api.issue_create("bug", "B", "", six[:5])["issue"]["id"]
        for _ in range(3):
            self.assertTrue(self.api.issue_comment(iid, "more", six[:5])["ok"])
        self.assertIn("too many files", self.api.issue_comment(iid, "more", six[:1])["error"])

    def test_deleting_an_issue_removes_its_files(self):
        iid = self.api.issue_create("bug", "B", "", [f("a.png", PNG)])["issue"]["id"]
        self.api.issue_comment(iid, "x", [f("b.jpg", JPG)])
        self.assertEqual(len(self.files_on_disk()), 2)
        self.gc.account_upn = "boss@nucor.com"
        self.assertTrue(self.api.issue_delete(iid)["ok"])
        self.assertEqual(self.files_on_disk(), [])

    def test_unknown_attachment_and_signed_out(self):
        iid = self.api.issue_create("bug", "B", "", [f("a.png", PNG)])["issue"]["id"]
        self.assertFalse(self.api.issue_attachment(iid, "a-nope")["ok"])
        self.gc.account_upn = ""
        self.assertFalse(self.api.issue_attachment(iid, "a-nope")["ok"])


class LibraryWithoutMetadataColumns(unittest.TestCase):
    """The Hub Files library may lack Division / Kind / Item Id columns: the upload must still succeed."""

    def test_upload_survives_a_failing_metadata_patch(self):
        import hubstore
        calls = []

        class R:
            content = b""

            def json(self_):
                return {"id": "item1"} if self_.kind == "PUT" else {"id": "li9"}

            def __init__(self_, kind):
                self_.kind = kind

        class GC:
            division = {"id": "_platform"}

            def _ensure_site(self):
                return "site"

            def _list_id(self, k):
                return "lib"

            def _col_map(self, k):
                return {}

            def _req(self, method, url, **kw):
                calls.append((method, url.split("?")[0][-30:]))
                if method == "PATCH":
                    raise RuntimeError('400: Field Division is not recognized')
                return R(method)
        st = hubstore.SharePointHubStore(GC(), div_id="_platform")
        st.put_bytes("iss-1-a-1.png", PNG)                                   # must not raise
        st._blob_put("setup.html", "<html></html>")                          # same rule for the older text blobs
        self.assertEqual([c[0] for c in calls].count("PUT"), 2)
        self.assertIn("PATCH", [c[0] for c in calls])


if __name__ == "__main__":
    unittest.main()
