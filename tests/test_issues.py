import tempfile
import unittest

import _env                     # noqa: F401
from _env import FakeSite, make_client

import app
import hub as hubmod
import issues
import notify
import settings_catalog as sc
from hub import Hub


class FakeResp:
    def __init__(self, code=200):
        self.status_code = code


class Pure(unittest.TestCase):
    def test_new_issue_validates_and_cleans(self):
        me = issues.person("A@Nucor.com", "A B")
        d = issues.new_issue("bug", "  Title\x00 here ", "detail", me, {"id": "nbgtx", "name": "TX"}, "2026.10.01")
        self.assertEqual((d["title"], d["status"], d["reporter"]["upn"], d["division"]["id"]), ("Title here", "new", "a@nucor.com", "nbgtx"))
        with self.assertRaises(issues.IssueError):
            issues.new_issue("idea", "x", "", me, {})
        with self.assertRaises(issues.IssueError):
            issues.new_issue("bug", "   ", "", me, {})
        with self.assertRaises(issues.IssueError):
            issues.new_issue("bug", "x" * 121, "", me, {})

    def test_comment_vote_watch_and_triage(self):
        me, boss = issues.person("a@x.com", "A"), issues.person("boss@x.com", "Boss")
        d = issues.new_issue("feature", "T", "", me, {})
        issues.apply_comment(d, boss, " hello ")
        self.assertEqual((d["comments"][0]["text"], "boss@x.com" in d["watchers"]), ("hello", True))
        with self.assertRaises(issues.IssueError):
            issues.apply_comment(d, boss, "  ")
        self.assertTrue(issues.toggle(d, "votes", "a@x.com"))
        self.assertFalse(issues.toggle(d, "votes", "a@x.com"))
        self.assertEqual(issues.apply_triage(d, boss, {"status": "planned", "assignee": {"upn": "Dev@x.com", "name": "Dev"}}), ["status", "status"])
        self.assertEqual((d["status"], d["assignee"]["upn"]), ("planned", "dev@x.com"))
        self.assertEqual(issues.apply_triage(d, boss, {"status": "planned"}), [])                  # no change -> nothing to announce
        with self.assertRaises(issues.IssueError):
            issues.apply_triage(d, boss, {"status": "bogus"})
        issues.apply_triage(d, boss, {"assignee": None})
        self.assertIsNone(d["assignee"])

    def test_summary_flags(self):
        d = issues.new_issue("bug", "T", "", issues.person("a@x.com", "A"), {})
        d["votes"] = ["b@x.com"]
        s = issues.summary(d, "B@x.com")
        self.assertEqual((s["voted"], s["mine"], s["votes"]), (True, False, 1))
        self.assertTrue(issues.summary(d, "a@x.com")["mine"])


class Recipients(unittest.TestCase):
    def setUp(self):
        self.d = issues.new_issue("bug", "T", "d", issues.person("rep@x.com", "Rep"), {"id": "w", "name": "W"})
        self.d["assignee"] = issues.person("dev@x.com", "Dev")
        self.d["watchers"] = ["watch@x.com"]
        self.subs = notify.subscribers_doc({"subscribers": [
            {"upn": "ALL@x.com", "name": "All", "events": ["new", "status", "comment"]},
            {"upn": "new@x.com", "events": ["new"]}, {"upn": "bad"}, {"upn": "all@x.com"}]})

    def upns(self, event, actor=""):
        return sorted(r["upn"] for r in notify.recipients(self.d, event, self.subs, actor))

    def test_subscriber_clean_up(self):
        self.assertEqual([s["upn"] for s in self.subs], ["all@x.com", "new@x.com"])                # invalid and duplicate dropped

    def test_who_hears_what_and_never_the_actor(self):
        self.assertEqual(self.upns("new"), ["all@x.com", "new@x.com"])                              # only subscribers for 'new'
        self.assertEqual(self.upns("status"), ["all@x.com", "dev@x.com", "rep@x.com", "watch@x.com"])
        self.assertEqual(self.upns("comment", actor="REP@x.com"), ["all@x.com", "dev@x.com", "watch@x.com"])

    def test_render_escapes_html(self):
        self.d["title"] = "<b>x</b> & y"
        subject, text, body = notify.render(self.d, "new", "Actor")
        self.assertIn("<b>x</b> & y", subject)
        self.assertNotIn("<b>x</b>", body)
        self.assertIn("&lt;b&gt;x&lt;/b&gt;", body)


class Delivery(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        FakeSite(self.gc)
        self.posts = []
        self._orig = notify.requests.post
        notify.requests.post = lambda url, **kw: self.posts.append((url, kw)) or FakeResp(self.code)
        self.code = 200
        self.d = issues.new_issue("bug", "T", "", issues.person("a@x.com", "A"), {"id": "w", "name": "W"})
        self.to = [{"upn": "b@x.com", "name": "B"}]

    def tearDown(self):
        notify.requests.post = self._orig

    def deliver(self):
        return notify.deliver(self.gc, self.to, "S", "t", "<p>t</p>", "new", self.d)

    def test_webhook_gets_a_clean_json_payload(self):
        self.gc._base_cfg["notify_webhook_url"] = "https://flow.example.com/hook?sig=abc"
        r = self.deliver()
        self.assertEqual((r["sent"], r["via"], r["error"]), (1, "webhook", ""))
        url, kw = self.posts[0]
        self.assertEqual(kw["json"]["to"], ["b@x.com"])
        self.assertEqual(kw["json"]["issue"]["title"], "T")
        self.code = 500
        self.assertIn("500", self.deliver()["error"])

    def test_no_way_to_send_is_reported_not_raised(self):
        r = self.deliver()
        self.assertEqual(r["sent"], 0)
        self.assertIn("No way to send", r["error"])
        self.assertEqual(self.posts, [])

    def test_mail_is_used_only_when_the_token_already_has_it(self):
        sent = []
        self.gc._granted_scopes = {"mail.send"}
        self.gc._req = lambda m, u, **kw: sent.append((m, u, kw)) or FakeResp(202)
        r = self.deliver()
        self.assertEqual((r["sent"], r["via"]), (1, "mail"))
        self.assertTrue(sent[0][1].endswith("/me/sendMail"))
        self.assertEqual(sent[0][2]["json"]["message"]["toRecipients"][0]["emailAddress"]["address"], "b@x.com")
        self.assertFalse(make_client().can_send_mail())

    def test_local_mode_and_empty_list_send_nothing(self):
        self.gc.data_mode = "local"
        self.assertEqual(self.deliver()["sent"], 0)
        self.assertEqual(notify.deliver(self.gc, [], "S", "t", "h", "new", self.d)["sent"], 0)

    def test_webhook_setting_must_be_https(self):
        self.assertEqual(sc.check_value("notify_webhook_url", "https://flow.example.com/x"), "https://flow.example.com/x")
        with self.assertRaises(ValueError):
            sc.check_value("notify_webhook_url", "http://flow.example.com/x")


class Counts(unittest.TestCase):
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

    def tearDown(self):
        hubmod.platform_hub_for = self._orig
        notify.deliver = self._od

    def as_(self, upn, name=""):
        self.gc.account_upn, self.gc.account_name = upn, name or upn

    def test_new_issues_start_as_new_and_leave_the_count_when_triaged(self):
        self.as_("tech@nucor.com", "Tech")
        a = self.api.issue_create("bug", "One")["issue"]
        self.api.issue_create("feature", "Two")
        self.assertEqual(a["status"], "new")
        self.as_("boss@nucor.com", "Boss")
        self.assertEqual(self.api.issue_counts("")["new"], 2)
        self.assertTrue(self.api.issue_counts("")["triage"])
        self.api.issue_update(a["id"], {"status": "open"})
        self.assertEqual(self.api.issue_counts("")["new"], 1)
        self.assertIn("new", [s["id"] for s in self.api.issues_list()["statuses"]])

    def test_everyone_else_counts_news_on_their_own_issues_not_their_own_actions(self):
        self.as_("tech@nucor.com", "Tech")
        iid = self.api.issue_create("bug", "Mine")["issue"]["id"]
        self.api.issue_create("bug", "Not involved")
        before = "2000-01-01T00:00:00Z"
        self.assertEqual(self.api.issue_counts(before)["updates"], 0)                            # I made it myself: no news
        self.as_("boss@nucor.com", "Boss")
        self.api.issue_comment(iid, "looking at it")
        self.as_("tech@nucor.com", "Tech")
        r = self.api.issue_counts(before)
        self.assertEqual((r["updates"], r["triage"]), (1, False))
        self.assertEqual(self.api.issue_counts("2999-01-01T00:00:00Z")["updates"], 0)            # already seen
        self.api.issue_comment(iid, "thanks")                                                    # my own follow-up is not news
        self.assertEqual(self.api.issue_counts("2999-01-01T00:00:00Z")["updates"], 0)


class Board(unittest.TestCase):
    """The Api end to end with a folder-backed platform hub."""

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
        self.sent = []
        self._od = notify.deliver
        notify.deliver = lambda gc, to, subject, text, body, event, issue: self.sent.append((event, [r["upn"] for r in to])) or \
            {"sent": len(to), "via": "webhook", "error": ""}
        self.as_("tech@nucor.com", "Tech")

    def tearDown(self):
        hubmod.platform_hub_for = self._orig
        notify.deliver = self._od

    def as_(self, upn, name=""):
        self.gc.account_upn, self.gc.account_name = upn, name or upn

    def make(self, title="Broken thing"):
        r = self.api.issue_create("bug", title, "details")
        self.assertTrue(r["ok"], r)
        return r["issue"]["id"]

    def test_anyone_can_report_comment_vote_and_watch(self):
        iid = self.make()
        self.as_("other@nucor.com", "Other")
        self.assertTrue(self.api.issue_comment(iid, "me too")["ok"])
        self.assertEqual(self.api.issue_vote(iid)["votes"], 1)
        self.assertFalse(self.api.issue_vote(iid)["voted"])                                         # toggles
        lst = self.api.issues_list()
        self.assertEqual((len(lst["issues"]), lst["triage"], lst["issues"][0]["comments"]), (1, False, 1))
        self.assertTrue(lst["issues"][0]["watching"])

    def test_signed_out_users_cannot_do_anything(self):
        self.as_("")
        self.assertIn("Sign in", self.api.issue_create("bug", "x")["error"])
        self.assertFalse(self.api.issues_list()["ok"])

    def test_only_super_admins_triage_and_delete(self):
        iid = self.make()
        self.assertIn("super admin", self.api.issue_update(iid, {"status": "done"})["error"])
        self.assertIn("super admin", self.api.issue_delete(iid)["error"])
        self.as_("boss@nucor.com", "Boss")
        r = self.api.issue_update(iid, {"status": "in_progress", "assignee": {"upn": "dev@nucor.com", "name": "Dev"}})
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["issue"]["status"], r["issue"]["assignee"]["upn"]), ("in_progress", "dev@nucor.com"))
        self.assertTrue(self.api.issue_delete(iid)["ok"])
        self.assertEqual(self.api.issues_list()["issues"], [])

    def test_issues_are_read_only_after_filing_except_for_super_admins(self):
        iid = self.make()
        for fields in ({"title": "Better title"}, {"detail": "changed"}, {"type": "feature"}, {"status": "done"}):
            self.assertIn("Only a super admin", self.api.issue_update(iid, fields)["error"])         # even the reporter
        self.assertFalse(self.api.issue_get(iid)["can_edit"])
        self.assertEqual(self.api.issue_get(iid)["issue"]["title"], "Broken thing")
        self.assertTrue(self.api.issue_comment(iid, "extra detail here")["ok"])                       # the reporter follows up with comments
        self.as_("boss@nucor.com", "Boss")
        self.assertTrue(self.api.issue_get(iid)["can_edit"])
        r = self.api.issue_update(iid, {"title": "Clearer title", "detail": "new text", "type": "feature", "status": "planned"})
        self.assertTrue(r["ok"], r)
        got = self.api.issue_get(iid)["issue"]
        self.assertEqual((got["title"], got["detail"], got["type"], got["status"]), ("Clearer title", "new text", "feature", "planned"))
        self.assertTrue(any(h["action"] == "edited" for h in got["history"]))

    def test_notifications_follow_the_subscriber_rules(self):
        self.as_("boss@nucor.com", "Boss")
        self.assertTrue(self.api.save_issue_subscribers([{"upn": "watcher@nucor.com", "name": "W", "events": ["new", "status"]}])["ok"])
        self.as_("tech@nucor.com", "Tech")
        iid = self.make()
        self.assertEqual(self.sent, [("new", ["watcher@nucor.com"])])
        self.as_("boss@nucor.com", "Boss")
        self.api.issue_update(iid, {"status": "done"})
        self.assertIn(("status", ["tech@nucor.com", "watcher@nucor.com"]), [(e, sorted(t)) for e, t in self.sent])
        hist = self.api.issue_get(iid)["issue"]["history"]
        self.assertTrue(any(h["action"] == "notify" and "notified" in h["detail"] for h in hist))

    def test_subscriber_management_is_super_admin_only_and_capped(self):
        self.assertFalse(self.api.save_issue_subscribers([])["ok"])
        self.assertEqual(self.api.get_issue_notifications(), {"ok": True, "super_admin": False})
        self.as_("boss@nucor.com")
        info = self.api.get_issue_notifications()
        self.assertEqual((info["webhook_set"], info["can_mail"], info["subscribers"]), (False, False, []))
        self.assertFalse(self.api.save_issue_subscribers([{"upn": f"u{i}@x.com"} for i in range(51)])["ok"])

    def test_import_of_the_old_feedback_lists_happens_once(self):
        self.as_("boss@nucor.com", "Boss")
        div = {"id": "nbgw", "name": "NBGW", "enabled": True}
        self.gc.registry = [div]
        old = Hub(logs_folder=tempfile.mkdtemp(), division={"id": "nbgw", "name": "NBGW", "legacy_data": False, "sites": []})
        old.add_feedback({"type": "feature", "title": "Old idea", "detail": "x"})
        old.add_feedback({"type": "bug", "title": "Old bug"})
        fid = old.get_feedback()[0]["id"]
        rec = old.get_feedback()[0]
        rec["status"] = "closed"
        old._write(__import__("os").path.join(old.feedback_dir, fid + ".json"), __import__("json").dumps(rec))
        import hub as hm
        orig = hm.hub_for
        hm.hub_for = lambda c: old
        self.gc.clone_for_snapshot = lambda: type("C", (), {"set_division": lambda s, i, persist=False: None})()
        try:
            self.assertEqual(self.api.issues_import_legacy()["imported"], 2)
            self.assertEqual(self.api.issues_import_legacy()["imported"], 0)
        finally:
            hm.hub_for = orig
        titles = {i["title"]: i["status"] for i in self.api.issues_list()["issues"]}
        self.assertEqual(titles, {"Old idea": titles["Old idea"], "Old bug": titles["Old bug"]})
        self.assertEqual(sorted(titles.values()), ["done", "open"])


if __name__ == "__main__":
    unittest.main()
