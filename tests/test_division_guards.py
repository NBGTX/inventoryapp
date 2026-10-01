import unittest

import _env
from _env import make_client

import app
import divisions


class DivisionGuards(unittest.TestCase):
    def setUp(self):
        self.api = app.Api()

    def test_timesheet_never_falls_back_to_another_divisions_server(self):
        gc = make_client(central=False)
        gc.registry.append({"id": "nbgtx", "name": "TX", "company_name": "NBG - Terrell", "sites": [], "lists": {},
                            "legacy_data": False, "sql_server": ""})
        gc.set_division("nbgtx")
        self.api._gc = gc
        with self.assertRaises(RuntimeError):
            self.api._ts_server()
        r = self.api.ts_weeks("123")
        self.assertFalse(r["ok"])
        self.assertIn("not configured", r["error"])

    def test_timesheet_uses_the_active_divisions_server(self):
        gc = make_client(central=False)
        self.api._gc = gc
        self.assertEqual(self.api._ts_server(), "BGBRISQL07")

    def test_public_division_exposes_ad_domain_and_timesheet_flag(self):
        d = divisions.load_registry({})[0]
        p = divisions.public(d)
        self.assertEqual(p["ad_domain"], "bg.nucorsteel.local")
        self.assertTrue(p["has_timesheet"])
        d2 = dict(d, sql_server="", ad_domain="")
        self.assertFalse(divisions.public(d2)["has_timesheet"])

    def test_locate_devices_without_ad_domain_reports_error_not_nbgw_domain(self):
        gc = make_client(central=False)
        gc.registry.append({"id": "nbgtx", "name": "TX", "company_name": "x", "sites": [], "lists": {},
                            "legacy_data": False, "ad_domain": ""})
        gc.set_division("nbgtx")
        gc.cfg["ad_domain"] = ""
        self.api._gc = gc
        gc.intune_lastsync_map = lambda: {}
        gc.entra_device_map = lambda h: {}
        gc.sign_in = lambda interactive=False: "t"
        r = self.api.locate_devices([{"serial": "S1", "hostname": "H1"}])
        self.assertTrue(r["ok"])
        self.assertEqual(r["ad_domain"], "")
        self.assertIn("No AD domain", r["ad_error"])


if __name__ == "__main__":
    unittest.main()


class TimesheetNames(unittest.TestCase):
    def conf(self, **extra):
        gc = make_client(central=False)
        gc.registry.append(dict({"id": "nbgtx", "name": "TX", "company_name": "c", "sites": [], "lists": {}, "legacy_data": False,
                                 "sql_server": "TXSQL01", "timesheet_db": "TXTime", "timesheet_table": "dbo.Locks",
                                 "employee_db": "TXEmp", "employee_table": "hr.People"}, **extra))
        gc.set_division("nbgtx", persist=False)
        api = app.Api()
        api._gc = gc
        return api

    def test_all_four_names_come_from_the_division(self):
        c = self.conf()._ts_conf()
        self.assertEqual((c["server"], c["timesheet_db"], c["employee_db"]), ("TXSQL01", "TXTime", "TXEmp"))
        self.assertEqual((c["ts_table"], c["emp_table"]), ("[dbo].[Locks]", "[hr].[People]"))

    def test_missing_names_disable_the_tool_instead_of_defaulting(self):
        for k in ("timesheet_db", "timesheet_table", "employee_db", "employee_table"):
            with self.assertRaises(RuntimeError) as cm:
                self.conf(**{k: ""})._ts_conf()
            self.assertIn("not fully configured", str(cm.exception))

    def test_injection_in_names_is_rejected(self):
        for bad in ("dbo.Locks; DROP TABLE x", "a.b.c", "x y", "dbo.[Locks]", ""):
            with self.assertRaises(RuntimeError):
                app.Api._sql_ident(bad)
        with self.assertRaises(RuntimeError):
            self.conf(timesheet_db="db;DROP")._ts_conf()

    def test_queries_use_the_division_names_and_stay_parameterized(self):
        import sqltools
        seen = []
        orig = sqltools.run
        sqltools.run = lambda server, db, sql, params=None, nonquery=False, timeout=45: (seen.append((server, db, sql, params)), {"rows": []})[1]
        try:
            api = self.conf()
            api.ts_weeks("E1")
            api.ts_search("smith")
        finally:
            sqltools.run = orig
        self.assertEqual(seen[0][:2], ("TXSQL01", "TXTime"))
        self.assertIn("FROM [dbo].[Locks]", seen[0][2])
        self.assertEqual(seen[0][3], {"emp": "E1"})
        self.assertEqual(seen[1][:2], ("TXSQL01", "TXEmp"))
        self.assertIn("FROM [hr].[People]", seen[1][2])
        self.assertEqual(seen[1][3], {"q": "%smith%"})

    def test_legacy_nbgw_keeps_its_original_names(self):
        gc = make_client(central=False)
        api = app.Api()
        api._gc = gc
        c = api._ts_conf()
        self.assertEqual((c["timesheet_db"], c["ts_table"], c["employee_db"], c["emp_table"]),
                         ("NBSTimesheet", "[dbo].[WeekLocked]", "NBSEmployeeInfo", "[dbo].[SAP_Interface]"))
