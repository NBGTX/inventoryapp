import json
import os
import tempfile
import types
import unittest

import _env
from _env import FakeSite, make_client

import divisions
import hub
import hubstore
import load_central as lc
import localstore

DIV = divisions.load_registry({})[0]


class MemStore(hubstore.SharePointHubStore):
    """In-memory Hub Items + Hub Files; ROWS/BLOBS shared so two Hub instances see each other."""
    ROWS, BLOBS, _n = [], {}, 0

    def __init__(self, gc=None):
        self.gc = types.SimpleNamespace(division=DIV)
        self._rev, self._cache = {}, {}

    @classmethod
    def reset(cls):
        cls.ROWS, cls.BLOBS, cls._n = [], {}, 0

    def _col(self, d, key="hub_items"):
        return d.replace(" ", "")

    def _fetch_rows(self, kind):
        return [{"id": r["id"], "item_id": r["item_id"], "rev": r["rev"], "payload": r["payload"]}
                for r in MemStore.ROWS if r["kind"] == kind]

    def _apply(self, ops):
        for op in ops:
            if op[0] == "post":
                f = op[1]
                MemStore._n += 1
                MemStore.ROWS.append({"id": str(MemStore._n), "kind": f["Kind"], "item_id": f["ItemId"],
                                      "rev": int(f["Rev"]), "payload": f["Payload"]})
            elif op[0] == "patch":
                r = next(x for x in MemStore.ROWS if x["id"] == op[1])
                r["payload"], r["rev"] = op[2]["Payload"], int(op[2]["Rev"])
            else:
                MemStore.ROWS = [x for x in MemStore.ROWS if x["id"] != op[1]]

    def _blob_get(self, name):
        return MemStore.BLOBS.get(name)

    def _blob_head(self, name):
        return name in MemStore.BLOBS

    def _blob_put(self, name, text):
        MemStore.BLOBS[name] = text

    def _blob_del(self, name):
        MemStore.BLOBS.pop(name, None)


def sample_folder():
    root = tempfile.mkdtemp()
    hubdir = os.path.join(root, "_EndpointHub")
    os.makedirs(os.path.join(hubdir, "changes"))
    big = {"departments": {f"Dept {i}": {"groups": [{"name": f"g{j}", "count": j} for j in range(40)]} for i in range(60)}}
    files = {"nbgw-upgrade-list.json": {"items": [{"id": "u1", "serial": "S1", "priority": 3}]},
             "nbgw-perm-baselines.json": big,
             os.path.join("changes", "c1.json"): {"when": "2026-01-01", "user": "a"},
             os.path.join("changes", "c2.json"): {"when": "2026-01-02", "user": "b"}}
    for rel, data in files.items():
        with open(os.path.join(hubdir, rel), "w", encoding="utf-8") as f:
            json.dump(data, f)
    with open(os.path.join(root, "setup.html"), "w", encoding="utf-8") as f:
        f.write("<b>setup</b>")
    return root, big


class HubStore(unittest.TestCase):
    def setUp(self):
        MemStore.reset()
        self.root, self.big = sample_folder()
        self.files = hub.Hub(logs_folder=self.root, division=DIV)
        for kind, doc, text in hubstore.scan_folder(self.files.logs, self.files.hub):
            MemStore().write(kind, doc, text)
        self.central = hub.Hub(logs_folder=self.root, division=DIV, store=MemStore())

    def test_scan_maps_kinds(self):
        got = {(k, d) for k, d, _ in hubstore.scan_folder(self.files.logs, self.files.hub)}
        self.assertEqual(got, {("upgrade-list", "main"), ("perm-baselines", "main"), ("changes", "c1"),
                               ("changes", "c2"), ("blob", "setup.html")})

    def test_big_doc_is_chunked_and_roundtrips(self):
        parts = [r for r in MemStore.ROWS if r["kind"] == "perm-baselines"]
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(len(r["payload"]) <= hubstore.CHUNK for r in parts))
        self.assertEqual(self.central.get_perm_baselines(), self.big)

    def test_reads_equal_file_hub(self):
        self.assertEqual(self.central.get_upgrades(), self.files.get_upgrades())
        self.assertEqual(len(self.central.get_changes()), 2)

    def test_shrinking_a_doc_removes_extra_chunks(self):
        self.central.save_perm_baselines({"small": True})
        self.assertEqual(len([r for r in MemStore.ROWS if r["kind"] == "perm-baselines"]), 1)
        self.assertEqual(self.central.get_perm_baselines(), {"small": True})

    def test_conflict_detection_and_retry(self):
        a = hub.Hub(logs_folder=self.root, division=DIV, store=MemStore())
        b = hub.Hub(logs_folder=self.root, division=DIV, store=MemStore())
        a.get_hot_spares()
        b.get_hot_spares()
        b.add_hot_spare({"serial": "B1", "model": "m"}, actor="b")
        with self.assertRaises(hubstore.HubConflict):
            a.add_hot_spare({"serial": "A1", "model": "m"}, actor="a")
        a.get_hot_spares()
        a.add_hot_spare({"serial": "A1", "model": "m"}, actor="a")
        self.assertEqual(sorted(h["serial"] for h in a.get_hot_spares()), ["A1", "B1"])

    def test_setup_flow_and_html_blob(self):
        self.central.save_setup({"id": "SetupABC", "subject": "S", "type": "computer"}, html="<i>x</i>", filename="s2.html")
        self.assertEqual(MemStore.BLOBS["s2.html"], "<i>x</i>")
        self.assertEqual([s["id"] for s in self.central.get_setups()], ["SetupABC"])
        self.assertTrue(self.central.cancel_setup("SetupABC", "test")["ok"])
        self.assertEqual(self.central.get_setups(), [])

    def test_files_mode_unchanged_without_store(self):
        self.files.add_feedback({"type": "bug", "title": "t"})
        self.assertEqual(len(self.files.get_feedback()), 1)
        self.assertTrue(os.path.isdir(self.files.feedback_dir))


class Loader(unittest.TestCase):
    def setUp(self):
        self.gc = make_client()
        self.site = FakeSite(self.gc)
        self.store = localstore.LocalStore("nbgw")
        src_cols = {"memory (ram)": "Memory_x0028_RAM_x0029_", "site tag": "Site_x0020_Tag", "manufacturer": "Manufacturer",
                    "model": "Model", "title": "Title", "primary user": "Primary_x0020_User", "device name": "Device_x0020_Name"}
        self.store.replace_list("new_stock", src_cols, [
            {"id": "1", "fields": {"Title": "SN1", "Manufacturer": "Dell", "Model": "L5540", "Site_x0020_Tag": "LTR", "Memory_x0028_RAM_x0029_": "16 GB"}},
            {"id": "2", "fields": {"Title": "SN2", "Manufacturer": "HP"}},
            {"id": "3", "fields": {"Title": "", "Model": "blank serial"}}])
        self.store.replace_list("in_use", src_cols, [{"id": "9", "fields": {"Title": "SN9", "Primary_x0020_User": "a@nucor.com", "Device_x0020_Name": "BGLTRLT1"}}])
        self.store.replace_list("model_specs", {"cpu": "CPU", "title": "Title"}, [{"id": "m", "fields": {"Title": "L5540", "CPU": "i7"}}])
        self.store.replace_list("log", {}, [{"id": "l", "fields": {"Title": "Added SN1", "Action": "Added", "Serial": "SN1", "LoggedAt": "2026-07-15T14:02:00Z"}}])
        self.site.add("new_stock", Title="SN2", Division="nbgw")        # already loaded
        self.site.add("new_stock", Title="OTHER", Division="nbgtx")     # other division: ignored

    def test_plan_maps_columns_skips_existing_blank_and_other_divisions(self):
        p = lc.plan(self.gc, self.store, "nbgw")
        add = p["new_stock"]["add"]
        self.assertEqual(len(add), 1)
        self.assertEqual(add[0], {"Title": "SN1", "Manufacturer": "Dell", "Model": "L5540", "SiteTag": "LTR", "MemoryRAM": "16 GB"})
        self.assertEqual(p["new_stock"]["skip"], 2)          # SN2 exists + blank serial
        self.assertEqual(p["in_use"]["add"][0], {"Title": "SN9", "PrimaryUser": "a@nucor.com", "DeviceName": "BGLTRLT1"})
        self.assertEqual(p["model_specs"]["add"][0]["Title"], "L5540")
        self.assertEqual(p["log"]["add"][0]["LoggedAt"], "2026-07-15T14:02:00Z")

    def test_batch_post_stamps_division_and_batches_of_20(self):
        calls = []

        class R:
            def __init__(self, n):
                self.n = n

            def json(self):
                return {"responses": [{"id": str(i), "status": 201} for i in range(self.n)]}
        self.gc._req = lambda m, u, **k: (calls.append(k["json"]), R(len(k["json"]["requests"])))[1]
        failed = lc._batch_post(self.gc, "new_stock", [{"Title": f"S{i}"} for i in range(25)])
        self.assertEqual((failed, len(calls)), (0, 2))
        self.assertEqual(calls[0]["requests"][0]["body"]["fields"]["Division"], "nbgw")
        lc._batch_post(self.gc, "model_specs", [{"Title": "M"}])
        self.assertNotIn("Division", calls[-1]["requests"][0]["body"]["fields"])


if __name__ == "__main__":
    unittest.main()
