import os
import tempfile
import unittest

import _env

import securecache


@unittest.skipUnless(os.name == "nt", "DPAPI is Windows-only")
class SecureCache(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(), ".token_cache.bin")
        self.secret = '{"RefreshToken": {"x": {"secret": "SUPERSECRET-refresh-token"}}}'

    def test_roundtrip_and_not_plaintext_on_disk(self):
        securecache.write_secure(self.path, self.secret)
        raw = open(self.path, "rb").read()
        self.assertTrue(raw.startswith(securecache.MAGIC))
        self.assertNotIn(b"SUPERSECRET", raw)
        self.assertTrue(securecache.is_encrypted(self.path))
        self.assertEqual(securecache.read_secure(self.path), self.secret)

    def test_large_and_unicode(self):
        big = self.secret + "é" * 200000
        securecache.write_secure(self.path, big)
        self.assertEqual(securecache.read_secure(self.path), big)

    def test_legacy_plaintext_is_still_read(self):
        open(self.path, "w", encoding="utf-8").write(self.secret)
        self.assertFalse(securecache.is_encrypted(self.path))
        self.assertEqual(securecache.read_secure(self.path), self.secret)

    def test_corrupt_blob_returns_none_not_crash(self):
        open(self.path, "wb").write(securecache.MAGIC + b"garbage-not-a-dpapi-blob")
        self.assertIsNone(securecache.read_secure(self.path))

    def test_missing_file_returns_none(self):
        self.assertIsNone(securecache.read_secure(self.path + ".nope"))


if __name__ == "__main__":
    unittest.main()
