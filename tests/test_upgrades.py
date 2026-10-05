import tempfile
import unittest
from datetime import date

import _env                     # noqa: F401
from _env import FakeSite, make_client

import app
import settings_catalog as sc
import sync
import upgrade_rules as ur
from hub import Hub

TODAY = date(2026, 10, 1)


def row(serial, cpu="", warranty="", **kw):
    return dict({"serial": serial, "cpu": cpu, "warranty": warranty, "model": "M", "site_tag": "TER", "user": "u@x.com",
                 "device_name": "DEV-" + serial, "manufacturer": "HP"}, **kw)


class Rules(unittest.TestCase):
    def ev(self, rows, cpu=5, warr=0):
        return ur.evaluate([(r, "In Use") for r in rows], cpu, warr, TODAY)

    def test_cpu_rule_and_priority(self):
        out = self.ev([row("OLD", cpu="Intel Core i5-6300U"), row("NEW", cpu="Intel Core i7-1365U"), row("NOCPU")])
        self.assertEqual([d["serial"] for d in out], ["OLD"])
        self.assertEqual((out[0]["year"], out[0]["age"], out[0]["priority"]), (2015, 11, 5))
        self.assertIn("processor released 2015", out[0]["reasons"][0])
        mid = self.ev([row("MID", cpu="Intel Core i5-1135G7")])                                    # 2020 -> 6 yrs -> priority 3
        self.assertEqual((mid[0]["age"], mid[0]["priority"]), (6, 3))

    def test_cpu_rule_off_with_zero(self):
        self.assertEqual(self.ev([row("OLD", cpu="Intel Core i5-6300U")], cpu=0), [])

    def test_warranty_rule(self):
        rows = [row("W1", warranty="2025-09-01"), row("W2", warranty="2026-09-15"), row("FUT", warranty="2027-01-01"),
                row("NONE")]
        self.assertEqual(self.ev(rows), [])                                                       # off by default
        out = self.ev(rows, warr=6)
        self.assertEqual([d["serial"] for d in out], ["W1"])                                      # W2 ended less than a month ago
        self.assertEqual((out[0]["months_past"], out[0]["priority"]), (13, 3))
        self.assertIn("warranty ended 2025-09-01", out[0]["reasons"][0])
        self.assertEqual([d["serial"] for d in self.ev(rows, warr=1)], ["W1"])

    def test_both_rules_combine_and_take_the_higher_priority(self):
        out = self.ev([row("B", cpu="Intel Core i7-8650U", warranty="2022-01-01")], warr=6)
        self.assertEqual(len(out[0]["reasons"]), 2)
        self.assertEqual(out[0]["priority"], 5)

    def test_missing_serial_is_skipped_and_order_is_oldest_first(self):
        out = self.ev([row("", cpu="Intel Core i5-6300U"), row("B", cpu="Intel Core i7-8650U"), row("A", cpu="Intel Core i5-6300U")])
        self.assertEqual([d["serial"] for d in out], ["A", "B"])

    def test_missing_specs(self):
        tagged = [(row("OK", cpu="i5", warranty="2027-01-01", ram="16 GB"), "In Use"),
                  (row("NOCPU", warranty="2027-01-01", ram="16 GB"), "In Use"),
                  (row("BARE"), "In Stock"),
                  (row("VM", manufacturer="VMware, Inc."), "In Use"),
                  (row("", manufacturer="HP"), "In Use")]
        out = ur.missing_specs(tagged)
        self.assertEqual([d["serial"] for d in out], ["BARE", "NOCPU"])
        self.assertEqual(out[0]["missing"], ["CPU", "RAM", "Warranty"])
        self.assertEqual(out[1]["missing"], ["CPU"])


class IgnoreList(unittest.TestCase):
    def setUp(self):
        self.hub = Hub(logs_folder=tempfile.mkdtemp(),
                       division={"id": "nbgtx", "name": "TX", "legacy_data": False, "sites": [{"code": "TER", "name": "T"}]})
        self.dev = {"serial": "S1", "device_name": "D1", "model": "M", "site": "TER", "user": "u", "year": 2015, "age": 11,
                    "reasons": ["warranty ended 2023-01-01 (45 months ago)"], "priority": 4}

    def ids(self):
        return [i["serial"] for i in (self.hub.get_upgrades() or {}).get("items", [])]

    def test_auto_add_uses_reasons_and_priority(self):
        self.assertEqual(self.hub.ensure_upgrades([self.dev], "bot")["added"], 1)
        it = self.hub.get_upgrades()["items"][0]
        self.assertEqual(it["priority"], 4)
        self.assertEqual(it["notes"], "Auto-added: warranty ended 2023-01-01 (45 months ago)")
        self.assertEqual(self.hub.ensure_upgrades([self.dev], "bot")["added"], 0)                   # idempotent

    def test_completed_and_removed_do_not_come_back(self):
        self.hub.ensure_upgrades([self.dev, dict(self.dev, serial="S2")], "bot")
        first, second = [i["id"] for i in self.hub.get_upgrades()["items"]]
        self.hub.complete_upgrade(first, "me")
        self.hub.remove_upgrade(second, "me")
        self.assertEqual(self.ids(), [])
        self.assertEqual(self.hub.ensure_upgrades([self.dev, dict(self.dev, serial="S2")], "bot")["added"], 0)
        self.assertEqual(set(self.hub.get_upgrade_ignored()), {"s1", "s2"})
        self.assertEqual(self.hub.get_upgrade_ignored()["s1"]["why"], "completed")

    def test_manual_add_and_clear_allow_it_again(self):
        self.hub.ensure_upgrades([self.dev], "bot")
        self.hub.complete_upgrade(self.hub.get_upgrades()["items"][0]["id"], "me")
        self.hub.add_upgrade({"serial": "S1"}, 3, "again", "me")                                    # a person re-queues it
        self.assertEqual(self.ids(), ["S1"])
        self.assertEqual(self.hub.get_upgrade_ignored(), {})
        self.hub.complete_upgrade(self.hub.get_upgrades()["items"][0]["id"], "me")
        self.assertEqual(self.hub.clear_upgrade_ignored(), 1)
        self.assertEqual(self.hub.ensure_upgrades([self.dev], "bot")["added"], 1)

    def test_saving_the_list_does_not_lose_the_ignore_list(self):
        self.hub.ensure_upgrades([self.dev], "bot")
        self.hub.complete_upgrade(self.hub.get_upgrades()["items"][0]["id"], "me")
        self.hub.save_upgrades({"items": []}, "me")
        self.assertIn("s1", self.hub.get_upgrade_ignored())


class Bulk(unittest.TestCase):
    def setUp(self):
        self.hub = Hub(logs_folder=tempfile.mkdtemp(),
                       division={"id": "nbgtx", "name": "TX", "legacy_data": False, "sites": [{"code": "TER", "name": "T"}]})
        for sn in ("A", "B", "C"):
            self.hub.add_upgrade({"serial": sn, "model": "M", "site": "TER"}, 3, "", "me")
        self.ids = {i["serial"]: i["id"] for i in self.hub.get_upgrades()["items"]}

    def items(self):
        return {i["serial"]: i for i in self.hub.get_upgrades()["items"]}

    def test_priority_and_site_change_only_the_chosen_rows(self):
        r = self.hub.bulk_upgrades("priority", [self.ids["A"], self.ids["B"]], priority=5, actor="me")
        self.assertEqual(r["done"], 2)
        it = self.items()
        self.assertEqual((it["A"]["priority"], it["B"]["priority"], it["C"]["priority"]), (5, 5, 3))
        self.assertEqual(it["A"]["history"][-1]["action"], "updated")
        self.hub.bulk_upgrades("site", [self.ids["C"]], site="LTR", actor="me")
        self.assertEqual(self.items()["C"]["site"], "LTR")
        with self.assertRaises(ValueError):
            self.hub.bulk_upgrades("priority", [self.ids["A"]], priority="x")
        with self.assertRaises(ValueError):
            self.hub.bulk_upgrades("site", [self.ids["A"]], site=" ")

    def test_complete_logs_each_and_blocks_auto_requeue_remove_does_not_log(self):
        self.hub.bulk_upgrades("complete", [self.ids["A"], self.ids["B"]], actor="me")
        self.assertEqual(sorted(self.items()), ["C"])
        log = self.hub.get_upgrade_log()["entries"]
        self.assertEqual(sorted(e["serial"] for e in log), ["A", "B"])
        self.assertTrue(all(e["completed_by"] == "me" and e["completed_at"] for e in log))
        self.hub.bulk_upgrades("remove", [self.ids["C"]], actor="me")
        self.assertEqual(self.items(), {})
        self.assertEqual(len(self.hub.get_upgrade_log()["entries"]), 2)                          # removal is not a completion
        self.assertEqual(set(self.hub.get_upgrade_ignored()), {"a", "b", "c"})

    def test_unknown_action_and_unknown_ids(self):
        with self.assertRaises(ValueError):
            self.hub.bulk_upgrades("explode", [self.ids["A"]])
        self.assertEqual(self.hub.bulk_upgrades("remove", ["nope"], actor="me")["done"], 0)
        self.assertEqual(len(self.items()), 3)


class Queue(unittest.TestCase):
    def fake_gc(self, rows_use, rows_stock=(), settings=None):
        class G:
            account_name = "bot"

            def get_in_use(s):
                return list(rows_use)

            def get_new_stock(s):
                return list(rows_stock)

            def get_setting(s, k, d=""):
                return (settings or {}).get(k, d)
        return G()

    def setUp(self):
        self.hub = Hub(logs_folder=tempfile.mkdtemp(), division={"id": "nbgtx", "name": "TX", "legacy_data": False, "sites": []})

    def test_queue_adds_once_and_respects_the_settings(self):
        rows = [row("OLD", cpu="Intel Core i5-6300U"), row("EXP", warranty="2022-01-01"),
                row("FINE", cpu="Intel Core i7-1365U", warranty="2030-01-01")]
        gc = self.fake_gc(rows)
        self.assertEqual(sync.queue_upgrades(gc, self.hub), 1)                                     # warranty rule is off by default
        self.assertEqual(sync.queue_upgrades(gc, self.hub), 0)
        gc2 = self.fake_gc(rows, settings={"upgrade_warranty_months": "6"})
        self.assertEqual(sync.queue_upgrades(gc2, self.hub), 1)
        self.assertEqual(sorted(i["serial"] for i in self.hub.get_upgrades()["items"]), ["EXP", "OLD"])

    def test_boneyard_stock_rows_are_not_queued(self):
        gc = self.fake_gc([], [row("BONE", cpu="Intel Core i5-6300U", status="Boneyard"), row("STK", cpu="Intel Core i5-6300U")])
        sync.queue_upgrades(gc, self.hub)
        self.assertEqual([i["serial"] for i in self.hub.get_upgrades()["items"]], ["STK"])

    def test_any_failure_is_swallowed(self):
        class Bad:
            def get_in_use(s):
                raise RuntimeError("down")
        self.assertEqual(sync.queue_upgrades(Bad(), self.hub), 0)


class SpecEditing(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        FakeSite(self.gc)
        self.api = app.Api()
        self.api._gc = self.gc
        self.updates, self.logs = [], []
        self.gc.find_by_serial = lambda key, s: {"id": "7", "fields": {"Title": s}} if (key, s) == ("in_use", "ABC") else None
        self.gc.update_item = lambda key, iid, vals: self.updates.append((key, iid, vals))
        self.gc.add_log = lambda *a, **k: self.logs.append((a, k))
        self.queued = []
        self._orig = sync.queue_upgrades
        sync.queue_upgrades = lambda gc, hub=None: self.queued.append(1) or 0

    def tearDown(self):
        sync.queue_upgrades = self._orig

    def test_saves_only_the_four_spec_fields_and_requeues_when_cpu_changes(self):
        r = self.api.update_device_specs("ABC", {"cpu": "  Intel  Core i5-6300U ", "ram": "16 GB", "user": "evil@x.com",
                                                 "warranty": "2027-05-31"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.updates, [("in_use", "7", {"cpu": "Intel Core i5-6300U", "ram": "16 GB", "warranty": "2027-05-31"})])
        self.assertEqual(self.queued, [1])
        self.assertEqual(len(self.logs), 1)

    def test_validation(self):
        self.assertIn("date", self.api.update_device_specs("ABC", {"warranty": "May 2027"})["error"])
        self.assertIn("too long", self.api.update_device_specs("ABC", {"cpu": "x" * 200})["error"])
        self.assertIn("not found", self.api.update_device_specs("NOPE", {"cpu": "i5"})["error"])
        self.assertEqual(self.updates, [])
        self.assertTrue(self.api.update_device_specs("ABC", {"user": "x"})["ok"])                   # nothing allowed -> nothing written
        self.assertEqual(self.updates, [])

    def test_bulk_writes_each_device_with_one_log_and_one_requeue(self):
        self.gc.find_by_serial = lambda key, s: {"id": s, "fields": {"Title": s}} if (key, s) in (("in_use", "A1"), ("new_stock", "B2")) else None
        r = self.api.update_specs_bulk([{"serial": "A1", "fields": {"cpu": "Intel i5", "user": "evil"}},
                                        {"serial": "B2", "fields": {"ram": " 16  GB"}}, {"serial": "ZZ", "fields": {"cpu": "x"}}, {"serial": "A1", "fields": {}}])
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["updated"], r["not_found"]), (2, ["ZZ"]))
        self.assertEqual(self.updates, [("in_use", "A1", {"cpu": "Intel i5"}), ("new_stock", "B2", {"ram": "16 GB"})])
        self.assertEqual((len(self.logs), self.queued), (1, [1]))

    def test_bulk_validates_before_writing_anything(self):
        r = self.api.update_specs_bulk([{"serial": "ABC", "fields": {"cpu": "i5"}}, {"serial": "ABC", "fields": {"warranty": "soon"}}])
        self.assertFalse(r["ok"])
        self.assertEqual(self.updates, [])

    def test_cpu_info(self):
        r = self.api.cpu_info("Intel Core i5-6300U")
        self.assertEqual((r["year"], r["age"]), (2015, date.today().year - 2015))
        self.assertIsNone(self.api.cpu_info("mystery chip")["year"])


class CatalogEntries(unittest.TestCase):
    def test_upgrade_settings(self):
        self.assertEqual(sc.check_value("upgrade_cpu_years", "7"), "7")
        self.assertEqual(sc.check_value("upgrade_warranty_months", ""), "")
        with self.assertRaises(ValueError):
            sc.check_value("upgrade_cpu_years", "99")


if __name__ == "__main__":
    unittest.main()
