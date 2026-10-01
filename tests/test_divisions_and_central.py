import unittest

import _env
from _env import FakeSite, make_client

import divisions
import graph


class DivisionsModule(unittest.TestCase):
    def test_legacy_fallback_is_nbgw(self):
        reg = divisions.load_registry({})
        self.assertEqual([d["id"] for d in reg], ["nbgw"])
        d = reg[0]
        self.assertEqual(divisions.site_codes(d), ["LTR", "BRI"])
        self.assertEqual(divisions.site_from_name(d, "BGCCN01"), "LTR")
        self.assertEqual(divisions.site_from_name(d, "BGBRILT1"), "BRI")
        self.assertEqual(divisions.site_from_name(d, "XYZ"), "")
        self.assertEqual(divisions.city_to_site(d, "Lathrop, CA"), "LTR")
        self.assertEqual(divisions.city_to_site(d, "Brigham City"), "BRI")
        self.assertEqual(divisions.site_bucket(d, "ltr"), "LTR")
        self.assertEqual(divisions.site_bucket(d, "Dallas"), "Other")
        self.assertEqual(divisions.hub_folder_name(d), "_EndpointHub")

    def test_config_divisions_and_hub_folder(self):
        reg = divisions.load_registry({"divisions": [
            {"id": "nbgtx", "name": "TX", "company_name": "NBG - Terrell", "intune_category": "NBGTX",
             "sites": [{"code": "TER", "city_prefixes": ["terrell"], "device_prefixes": ["BGTER"]}]}]})
        d = reg[0]
        self.assertEqual(divisions.hub_folder_name(d), "_EndpointHub_nbgtx")
        self.assertEqual(divisions.site_from_name(d, "BGTERLT1"), "TER")

    def test_legacy_flat_config_keys_override_defaults(self):
        d = divisions.load_registry({"site_path": "/sites/X", "intune_device_category": "ZZ"})[0]
        self.assertEqual((d["site_path"], d["intune_category"]), ("/sites/X", "ZZ"))


class CentralStore(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        self.site = FakeSite(self.gc)

    def test_central_overlay_changes_site_and_lists(self):
        self.assertTrue(self.gc._central)
        self.assertEqual(self.gc.cfg["site_path"], "/sites/NBGTX.nbghubdata")
        self.assertEqual(self.gc.cfg["lists"]["new_stock"], "Inventory - New Stock")
        self.assertEqual(self.gc.cfg["lists"]["hub_files"], "Inventory - Hub Files")

    def test_not_central_keeps_legacy_site(self):
        gc = make_client(central=False)
        self.assertFalse(gc._central)
        self.assertEqual(gc.cfg["site_path"], "/sites/NBGW/systems")

    def test_reads_filtered_by_division_and_shared_lists_not(self):
        self.site.add("new_stock", Title="A", Division="nbgw")
        self.site.add("new_stock", Title="B", Division="NBGTX")
        self.site.add("new_stock", Title="C")
        self.site.add("model_specs", Title="M1")
        self.assertEqual([i["fields"]["Title"] for i in self.gc._items_raw("new_stock")], ["A"])
        self.gc.registry.append({"id": "nbgtx", "name": "TX", "company_name": "x", "sites": [], "lists": {}, "legacy_data": False})
        self.gc.set_division("nbgtx")
        self.assertEqual([i["fields"]["Title"] for i in self.gc._items_raw("new_stock")], ["B"])
        self.assertEqual(len(self.gc._items_raw("model_specs")), 1)

    def test_writes_are_stamped_except_shared(self):
        self.gc._create_item("new_stock", {"Title": "Z"})
        self.assertEqual(self.site.sent[-1][2]["fields"], {"Title": "Z", "Division": "nbgw"})
        self.gc._create_item("model_specs", {"Title": "M"})
        self.assertEqual(self.site.sent[-1][2]["fields"], {"Title": "M"})

    def test_snapshot_flag_reads_legacy_site(self):
        self.gc._use_legacy = True
        self.gc._apply_division()
        self.assertFalse(self.gc._central)
        self.assertEqual(self.gc.cfg["site_path"], "/sites/NBGW/systems")
        self.gc._use_legacy = False
        self.gc._apply_division()
        self.assertTrue(self.gc._central)


class Registry(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        self.site = FakeSite(self.gc)
        tx = '[{"code":"TER","name":"Terrell","city_prefixes":["terrell"],"device_prefixes":["BGTER"]}]'
        self.site.add("divisions", Title="nbgw", DisplayName="NBGW Renamed", Enabled="Yes", AccessJson="[]")
        self.site.add("divisions", Title="nbgtx", DisplayName="TX", CompanyName="NBG - Terrell", IntuneCategory="NBGTX",
                      SitesJson=tx, Enabled="Yes", AccessJson='["tx@nucor.com"]')
        self.site.add("divisions", Title="old", DisplayName="Old", Enabled="No")
        self.site.add("divisions", Title="EXAMPLE-DELETE")
        self.gc.account_upn = "someone@nucor.com"

    def ids(self, reg):
        return sorted(d["id"] for d in reg)

    def test_merge_override_add_hide(self):
        self.gc.refresh_registry(force=True)
        self.assertEqual(self.ids(self.gc.registry), ["nbgtx", "nbgw"])
        self.assertEqual(next(d for d in self.gc.registry if d["id"] == "nbgw")["name"], "NBGW Renamed")

    def test_access_list_and_super_admin(self):
        self.gc.refresh_registry(force=True)
        self.assertEqual(self.ids(self.gc.visible_registry()), ["nbgw"])
        self.gc.account_upn = "TX@nucor.com"
        self.assertEqual(self.ids(self.gc.visible_registry()), ["nbgtx", "nbgw"])
        self.gc.account_upn = "someone@nucor.com"
        self.gc._base_cfg["super_admins"] = ["someone@nucor.com"]
        self.assertEqual(self.ids(self.gc.visible_registry()), ["nbgtx", "nbgw"])

    def test_failed_read_keeps_config_registry(self):
        def boom(k):
            raise RuntimeError("down")
        self.gc._items_raw = boom
        self.gc.refresh_registry(force=True)
        self.assertEqual(self.ids(self.gc.registry), ["nbgw"])

    def test_division_admin_validation_and_save(self):
        self.gc._base_cfg["super_admins"] = ["someone@nucor.com"]
        with self.assertRaises(graph.GraphError):
            self.gc.save_division_row({"id": "X", "name": "n", "company_name": "c", "intune_category": "i"})
        with self.assertRaises(graph.GraphError):
            self.gc.save_division_row({"id": "nbgsc", "name": "", "company_name": "c", "intune_category": "i"})
        with self.assertRaises(graph.GraphError):
            self.gc.save_division_row({"id": "nbgsc", "name": "n", "company_name": "c", "intune_category": "i",
                                       "sites": [{"code": "A"}]})
        self.gc.save_division_row({"id": "nbgsc", "name": "SC", "company_name": "NBG - Swansea", "intune_category": "NBGSC",
                                   "sites": [{"code": "swa", "name": "Swansea", "city_prefixes": ["swansea"], "device_prefixes": ["BGSWA"]}],
                                   "access": ["A@Nucor.com"]})
        post = [s for s in self.site.sent if s[0] == "POST"][-1][2]["fields"]
        self.assertEqual(post["Title"], "nbgsc")
        self.assertIn('"SWA"', post["SitesJson"])
        self.assertEqual(post["AccessJson"], '["a@nucor.com"]')
        self.assertEqual(post["Enabled"], "Yes")

    def test_division_admin_denied_for_non_admin(self):
        with self.assertRaises(graph.GraphError):
            self.gc.save_division_row({"id": "nbgsc"})


if __name__ == "__main__":
    unittest.main()


class DivisionTimesheetColumns(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        cols = dict(_env.DEFAULT_COLS)
        cols.update({"timesheet db": "field_20", "timesheet table": "field_21", "employee db": "field_22", "employee table": "field_23"})
        self.site = FakeSite(self.gc, colmaps={"divisions": cols})
        self.gc._base_cfg["super_admins"] = ["me@nucor.com"]
        self.gc.account_upn = "me@nucor.com"

    def row(self, **kw):
        d = {"id": "nbgtx", "name": "TX", "company_name": "NBG - Terrell", "intune_category": "NBGTX", "sites": [],
             "timesheet_db": "TXTime", "timesheet_table": "dbo.Locks", "employee_db": "TXEmp", "employee_table": "dbo.People"}
        d.update(kw)
        return d

    def test_saved_and_read_back_through_the_registry(self):
        self.gc.save_division_row(self.row())
        post = [s for s in self.site.sent if s[0] == "POST"][-1][2]["fields"]
        self.assertEqual((post["field_20"], post["field_21"], post["field_22"], post["field_23"]),
                         ("TXTime", "dbo.Locks", "TXEmp", "dbo.People"))
        self.site.add("divisions", Title="nbgtx", DisplayName="TX", CompanyName="NBG - Terrell", IntuneCategory="NBGTX",
                      field_20="TXTime", field_21="dbo.Locks", field_22="TXEmp", field_23="dbo.People", Enabled="Yes")
        self.gc._col_map = lambda k: {"display name": "DisplayName", "company name": "CompanyName", "intune category": "IntuneCategory",
                                      "enabled": "Enabled", "timesheet db": "field_20", "timesheet table": "field_21",
                                      "employee db": "field_22", "employee table": "field_23"}
        self.gc.refresh_registry(force=True)
        tx = next(d for d in self.gc.registry if d["id"] == "nbgtx")
        self.assertEqual((tx["timesheet_db"], tx["employee_table"]), ("TXTime", "dbo.People"))
        self.gc.set_division("nbgtx", persist=False)
        self.assertEqual(self.gc.cfg["timesheet_db"], "TXTime")

    def test_names_with_bad_characters_are_rejected(self):
        with self.assertRaises(graph.GraphError):
            self.gc.save_division_row(self.row(timesheet_table="dbo.Locks; DROP"))

    def test_clear_error_when_the_list_has_no_such_columns(self):
        gc = make_client()
        FakeSite(gc)                                     # default columns: no Timesheet/Employee columns
        gc._base_cfg["super_admins"] = ["me@nucor.com"]
        gc.account_upn = "me@nucor.com"
        with self.assertRaises(graph.GraphError) as cm:
            gc.save_division_row(self.row())
        self.assertIn("Timesheet DB", str(cm.exception))
        gc.save_division_row(self.row(timesheet_db="", timesheet_table="", employee_db="", employee_table=""))   # blank is fine
